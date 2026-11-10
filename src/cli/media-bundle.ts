import { gzipSync, gunzipSync } from 'node:zlib';
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

export async function bundleMedia(output: string): Promise<void> {
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
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bundle, { flag: 'wx' });
}

export async function importMedia(bundlePath: string): Promise<number> {
  const media = await pinnedMedia(),
    decoded = decodeMediaBundle(await readBounded(bundlePath, MAX_BUNDLE), media);
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
