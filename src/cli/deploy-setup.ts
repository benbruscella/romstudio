import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Diagnostic } from '../core.js';
import { pinnedMedia } from '../media/library.js';
import { repositoryRoot } from '../paths.js';
import {
  createMediaBundle,
  decodeMediaBundle,
  sealBundle,
  sealedMediaPath,
  unsealBundle,
} from './media-bundle.js';

/** Run `gh` (no shell) and return its standard output. */
function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk));
    child.on('error', (error) =>
      reject(new Diagnostic('GH', `GitHub CLI unavailable: ${error.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Diagnostic('GH', `gh ${args.slice(0, 2).join(' ')} failed: ${err.trim()}`)),
    );
    child.stdin.end(input ?? '');
  });
}

/** One-time (and repeatable) deployment setup, run from a machine that has
 * the original media. It seals the pinned inputs with a fresh key into
 * ci/rom-studio-media.sealed, stores that key as the Actions secret
 * MEDIA_KEY, and makes GitHub Pages publish from GitHub Actions. Commit ci/
 * afterwards: the secret and the sealed file must match. */
export async function deploySetup(log: (message: string) => void, domain?: string): Promise<void> {
  if (domain !== undefined && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    throw new Diagnostic('SITE_DOMAIN', 'Use a hostname such as romstud.io.');
  }
  const repository = await gh([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  const key = randomBytes(32),
    bundle = await createMediaBundle(),
    sealed = sealBundle(bundle, key);
  // Prove the sealed file opens and verifies before anything changes remotely.
  decodeMediaBundle(unsealBundle(sealed, key), await pinnedMedia());
  await mkdir(dirname(sealedMediaPath), { recursive: true });
  await writeFile(sealedMediaPath, sealed);
  log(
    `Sealed ${(sealed.length / 1048576).toFixed(1)} MB of pinned media into ${relative(repositoryRoot, sealedMediaPath)}.`,
  );
  await gh(['secret', 'set', 'MEDIA_KEY', '--repo', repository], key.toString('base64'));
  log(`Stored its key as the Actions secret MEDIA_KEY on ${repository}.`);
  const pages = await gh(['api', `repos/${repository}/pages`, '--jq', '.build_type']).catch(
    () => '',
  );
  if (pages === 'workflow') {
    log('GitHub Pages already publishes from GitHub Actions.');
  } else {
    await gh(
      pages
        ? ['api', '-X', 'PUT', `repos/${repository}/pages`, '-f', 'build_type=workflow']
        : ['api', '-X', 'POST', `repos/${repository}/pages`, '-f', 'build_type=workflow'],
    );
    log('GitHub Pages now publishes from GitHub Actions.');
  }
  if (domain) {
    // Only once DNS points at GitHub Pages: GitHub then redirects the
    // github.io project URL to this domain.
    // The workflow normally does this itself on deploy (PAGES_DOMAIN).
    await gh(['api', '-X', 'PUT', `repos/${repository}/pages`, '-f', `cname=${domain}`]);
    log(`GitHub Pages custom domain set to ${domain}.`);
  }
  log('Commit ci/rom-studio-media.sealed; every merge to main then builds, verifies and deploys.');
}
