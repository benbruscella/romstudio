import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, sha256 } from '../core.js';
import { gameBuildDirectory, repositoryRoot } from '../paths.js';
import { titles, type TitleId } from '../titles.js';
import { verifyWebImports } from './web-imports.js';

/**
 * Builds game packages for `npm run build` and `npm run dev`, in parallel
 * child processes. Packaging reuses saved recovery captures; a game without
 * a capture or package recovers once (without the original/static comparison,
 * which belongs to `verify-game` and the tests). Deploy builds verify every
 * game against the original, because they start from nothing on CI and
 * publish only packages verified for the current sources.
 */
export interface GameBuild {
  key: TitleId;
  work: boolean;
  description: string;
}

export function duration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

const packageExists = (key: TitleId) =>
  lstat(join(gameBuildDirectory(key), 'manifest.json')).then(
    () => true,
    () => false,
  );

/** Player files (shell, runtime, system and title modules, page and styles)
 * in an existing package that differ from the current compiled code.
 * Generated game code is not compared: it comes from recovery. */
export async function stalePlayerFiles(key: TitleId): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(join(gameBuildDirectory(key), 'manifest.json'), 'utf8'),
  ) as { files?: Record<string, string> };
  const compiled = fileURLToPath(new URL('../', import.meta.url));
  const stale: string[] = [];
  for (const [relative, hash] of Object.entries(manifest.files ?? {})) {
    const source =
      relative === 'index.html' || relative === 'style.css'
        ? join(repositoryRoot, 'src/web', relative)
        : relative.endsWith('.js') && !relative.startsWith('game-code/')
          ? join(compiled, relative)
          : undefined;
    if (!source) {
      continue;
    }
    const bytes = await readFile(source).catch(() => undefined);
    if (bytes && sha256(bytes) !== hash) {
      stale.push(relative);
    }
  }
  const symbols = await readFile(join(repositoryRoot, 'src/games', key, 'desk/symbols.json')).catch(
    () => undefined,
  );
  if (symbols && manifest.files?.['desk/symbols.json'] !== sha256(symbols)) {
    stale.push('desk/symbols.json');
  }
  return stale;
}

const playerSource = (key: TitleId, relative: string, compiled: string) =>
  relative === 'desk/symbols.json'
    ? join(repositoryRoot, 'src/games', key, 'desk/symbols.json')
    : relative === 'index.html' || relative === 'style.css'
      ? join(repositoryRoot, 'src/web', relative)
      : join(compiled, relative);

/** Copy changed player files into an existing package and re-hash its
 * manifest, without rerunning recovery. Returns false (a full rebuild is
 * needed) when a changed module imports a file the package lacks. A package
 * that had passed verification is marked stale. */
export async function refreshPlayerFiles(key: TitleId, stale: string[]): Promise<boolean> {
  const directory = gameBuildDirectory(key),
    manifestPath = join(directory, 'manifest.json'),
    compiled = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    exportId: string;
    files: Record<string, string>;
    verification?: { referenceReplay?: string; currentSource?: string };
  };
  const updates = new Map<string, Buffer>();
  for (const relative of stale) {
    updates.set(relative, await readFile(playerSource(key, relative, compiled)));
  }
  // Only the updated modules are scanned; every other file need only exist.
  const sources = new Map<string, string>(
    Object.keys(manifest.files)
      .filter((relative) => relative.endsWith('.js'))
      .map((relative) => [relative, updates.get(relative)?.toString() ?? '']),
  );
  try {
    verifyWebImports(sources);
  } catch {
    return false;
  }
  for (const [relative, bytes] of updates) {
    await mkdir(dirname(join(directory, relative)), { recursive: true });
    await writeFile(join(directory, relative), bytes);
    manifest.files[relative] = sha256(bytes);
  }
  manifest.exportId = sha256(JSON.stringify(manifest.files));
  if (manifest.verification?.referenceReplay === 'passed') {
    manifest.verification.referenceReplay = 'stale';
    manifest.verification.currentSource =
      'Player files refreshed with current code; run verify-game to verify again.';
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return true;
}

export async function planGameBuilds(options: { verify?: boolean } = {}): Promise<GameBuild[]> {
  const plan: GameBuild[] = [];
  for (const key of Object.keys(titles) as TitleId[]) {
    const title = titles[key];
    if (options.verify) {
      plan.push({
        key,
        work: true,
        description: 'recover and verify against the original, then package (minutes)',
      });
    } else if ('package' in title) {
      plan.push({
        key,
        work: true,
        description: (await title.hasCapture())
          ? 'package from saved capture with current code (seconds)'
          : 'first build: original recovery once, then package (a few minutes)',
      });
    } else if (await packageExists(key)) {
      const stale = await stalePlayerFiles(key);
      const changed = `${stale.slice(0, 3).join(', ')}${stale.length > 3 ? `, +${stale.length - 3} more` : ''}`;
      plan.push(
        !stale.length
          ? { key, work: false, description: 'reuse existing package (verify-game refreshes it)' }
          : (await refreshPlayerFiles(key, stale))
            ? { key, work: false, description: `refreshed player files in place (${changed})` }
            : {
                key,
                work: true,
                description: `rebuild: player code changed (${changed}) (a few minutes)`,
              },
      );
    } else {
      plan.push({
        key,
        work: true,
        description: 'first build: original recovery and packaging (a few minutes)',
      });
    }
  }
  return plan;
}

/** Runs `roms build-game` (or `verify-game` for deploy) for each planned game in a separate process, with
 * prefixed output, a heartbeat every 30 s and per-game timings. */
export async function buildGames(
  plan: readonly GameBuild[],
  progress: (message: string) => void,
  options: { verify?: boolean } = {},
): Promise<void> {
  const started = Date.now(),
    pending = plan.filter((game) => game.work),
    concurrency = Math.max(1, Math.min(pending.length, availableParallelism() - 1));
  progress(`Build plan (${plan.length} games, up to ${concurrency} at once):`);
  plan.forEach((game, index) =>
    progress(`  [${index + 1}/${plan.length}] ${game.key}: ${game.description}`),
  );
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const failures: string[] = [];
  const running = new Map<TitleId, number>();
  const heartbeat = setInterval(() => {
    for (const [key, since] of running) {
      progress(`  … ${key} still building (${duration(Date.now() - since)})`);
    }
  }, 30000);
  const buildOne = (key: TitleId) =>
    new Promise<void>((resolve) => {
      const since = Date.now();
      running.set(key, since);
      const child = spawn(
        process.execPath,
        [...process.execArgv, cli, options.verify ? 'verify-game' : 'build-game', key, '--quiet'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const relay = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) {
            progress(`  ${key} │ ${line}`);
          }
        }
      };
      child.stdout.on('data', relay);
      child.stderr.on('data', relay);
      child.on('close', (code, signal) => {
        running.delete(key);
        if (code === 0) {
          progress(`  ✓ ${key} built in ${duration(Date.now() - since)}`);
        } else {
          failures.push(key);
          progress(
            `  ✗ ${key} failed (${signal ?? `exit ${code}`}) after ${duration(Date.now() - since)}`,
          );
        }
        resolve();
      });
    });
  const queue = [...pending];
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let game = queue.shift(); game; game = queue.shift()) {
          await buildOne(game.key);
        }
      }),
    );
  } finally {
    clearInterval(heartbeat);
  }
  progress(
    `Built ${pending.length} of ${plan.length} games in ${duration(Date.now() - started)}` +
      (failures.length ? `; failed: ${failures.join(', ')}.` : '.'),
  );
  if (failures.length) {
    throw new Diagnostic('BUILD_GAMES', `Game builds failed: ${failures.join(', ')}.`);
  }
}
