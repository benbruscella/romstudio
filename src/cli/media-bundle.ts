import { gzipSync, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';
import { pinnedMedia } from '../media/library.js';
import { repositoryRoot } from '../paths.js';

interface Bundle {
  version: 1;
  files: { id: string; data: string }[];
}
const MAX_BUNDLE = 16777216;

/** The bundle contains bytes, never extraction paths. Only current recipe IDs
 * select destinations, and all hashes are checked before writing any input. */
export function decodeMediaBundle(
  bytes: Uint8Array,
  expected: readonly { id: string; sha256: string }[],
): Map<string, Uint8Array> {
  if (bytes.length > MAX_BUNDLE) {
    throw new Diagnostic('MEDIA_BUNDLE_SIZE', 'Media bundle exceeds 16 MiB.');
  }
  const bundle = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: MAX_BUNDLE }).toString(),
  ) as Bundle;
  if (
    bundle.version !== 1 ||
    !Array.isArray(bundle.files) ||
    bundle.files.length !== expected.length
  ) {
    throw new Diagnostic('MEDIA_BUNDLE', 'Bundle must contain exactly the pinned inputs.');
  }
  const identities = new Map(expected.map((medium) => [medium.id, medium.sha256])),
    decoded = new Map<string, Uint8Array>();
  for (const file of bundle.files) {
    if (
      !file ||
      typeof file.id !== 'string' ||
      typeof file.data !== 'string' ||
      !identities.has(file.id) ||
      decoded.has(file.id)
    ) {
      throw new Diagnostic('MEDIA_BUNDLE', 'Unexpected or duplicate media identity.');
    }
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data || sha256(data) !== identities.get(file.id)) {
      throw new Diagnostic('MEDIA_HASH', `Media bundle hash mismatch: ${file.id}.`);
    }
    decoded.set(file.id, data);
  }
  return decoded;
}

/** Encrypted media for CI, committed at `ci/rom-studio-media.sealed`. The
 * key lives only in the repository's Actions secret MEDIA_KEY. */
export const sealedMediaPath = join(repositoryRoot, 'ci/rom-studio-media.sealed');
const SEAL_MAGIC = Buffer.from('RSMEDIA1');

export function mediaKey(text = process.env.MEDIA_KEY): Buffer {
  const key = Buffer.from(text ?? '', 'base64');
  if (key.length !== 32) {
    throw new Diagnostic(
      'MEDIA_KEY',
      'MEDIA_KEY must be a base64 32-byte key. Run `npm run cli -- deploy-setup` to create one.',
    );
  }
  return key;
}

/** AES-256-GCM: magic, 12-byte IV, 16-byte tag, then the gzip bundle. */
export function sealBundle(bundle: Uint8Array, key: Uint8Array): Buffer {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(bundle), cipher.final()]);
  return Buffer.concat([SEAL_MAGIC, iv, cipher.getAuthTag(), body]);
}

export function isSealed(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, SEAL_MAGIC.length)).equals(SEAL_MAGIC);
}

export function unsealBundle(sealed: Uint8Array, key: Uint8Array): Buffer {
  if (!isSealed(sealed) || sealed.length < SEAL_MAGIC.length + 28) {
    throw new Diagnostic('MEDIA_SEALED', 'Not a sealed ROM Studio media bundle.');
  }
  const start = SEAL_MAGIC.length;
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(start, start + 12));
  decipher.setAuthTag(sealed.subarray(start + 12, start + 28));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(start + 28)), decipher.final()]);
  } catch {
    throw new Diagnostic(
      'MEDIA_KEY',
      'MEDIA_KEY does not open the sealed media. Run `npm run cli -- deploy-setup` and commit ci/.',
    );
  }
}

export async function createMediaBundle(): Promise<Buffer> {
  const files: Bundle['files'] = [];
  for (const medium of await pinnedMedia()) {
    const bytes = await readBounded(medium.path, MAX_BUNDLE);
    if (sha256(bytes) !== medium.sha256) {
      throw new Diagnostic('MEDIA_HASH', `SHA-256 mismatch: ${medium.name}.`);
    }
    files.push({ id: medium.id, data: bytes.toString('base64') });
  }
  const bundle = gzipSync(JSON.stringify({ version: 1, files }));
  if (bundle.length > MAX_BUNDLE) {
    throw new Diagnostic('MEDIA_BUNDLE_SIZE', 'Media bundle exceeds 16 MiB.');
  }
  return bundle;
}

export async function bundleMedia(output: string): Promise<void> {
  const bundle = await createMediaBundle();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bundle, { flag: 'wx' });
}

/** Restore the pinned inputs from a bundle, or from a sealed bundle using
 * MEDIA_KEY. Every hash is checked before any file is written. */
export async function importMedia(bundlePath: string): Promise<number> {
  const bytes = await readBounded(bundlePath, MAX_BUNDLE + 64);
  const media = await pinnedMedia(),
    decoded = decodeMediaBundle(isSealed(bytes) ? unsealBundle(bytes, mediaKey()) : bytes, media);
  for (const medium of media) {
    const parts = relative(repositoryRoot, dirname(medium.path)).split('/');
    let directory = repositoryRoot;
    for (const part of parts) {
      directory = join(directory, part);
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Diagnostic(
            'MEDIA_DESTINATION',
            'Media destination must contain real directories.',
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        await mkdir(directory);
      }
    }
    try {
      const stat = await lstat(medium.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        sha256(await readBounded(medium.path, MAX_BUNDLE)) !== medium.sha256
      ) {
        throw new Diagnostic(
          'MEDIA_DESTINATION',
          `Refusing to replace a different input: ${medium.name}.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await writeFile(medium.path, decoded.get(medium.id)!, { flag: 'wx' });
    }
  }
  return media.length;
}
