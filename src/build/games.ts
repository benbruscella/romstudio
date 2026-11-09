import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic } from '../core.js';
import { gameBuildDirectory } from '../paths.js';
import { titles, type TitleId } from '../titles.js';

/**
 * Builds game packages for `npm run build` and `npm run dev`, in parallel
 * child processes. Packaging reuses saved recovery captures; a game without
 * a capture or package recovers once (without the original/static comparison,
 * which belongs to `verify-game` and the tests).
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

export async function planGameBuilds(): Promise<GameBuild[]> {
  const plan: GameBuild[] = [];
  for (const key of Object.keys(titles) as TitleId[]) {
    const title = titles[key];
    if ('package' in title) {
      plan.push({
        key,
        work: true,
        description: (await title.hasCapture())
          ? 'package from saved capture with current code (seconds)'
          : 'first build: original recovery once, then package (a few minutes)',
      });
    } else if (await packageExists(key)) {
      plan.push({
        key,
        work: false,
        description: 'reuse existing package (verify-game refreshes it)',
      });
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

/** Runs `roms build-game` for each planned game in a separate process, with
 * prefixed output, a heartbeat every 30 s and per-game timings. */
export async function buildGames(
  plan: readonly GameBuild[],
  progress: (message: string) => void,
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
        [...process.execArgv, cli, 'build-game', key, '--quiet'],
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
