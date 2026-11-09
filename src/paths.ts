import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gameIdentity, type GameKey } from './game-id.js';

/** Compiled tools live in dist/tools/src; source/media remain at project root. */
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const buildDirectory = join(repositoryRoot, 'dist');
export const toolsDirectory = join(buildDirectory, 'tools');
export const workDirectory = join(buildDirectory, 'work');
export const siteDirectory = join(buildDirectory, 'site');
export function gameBuildDirectory(key: GameKey): string {
  const { system, id } = gameIdentity(key);
  return join(workDirectory, 'games', system, id);
}
/** Recovery captures: slow to produce, reused by every build, and kept
 * outside disposable dist/. Ignored by git: they contain game bytes. */
export const cacheDirectory = join(repositoryRoot, '.cache');
export function gameCaptureDirectory(key: GameKey): string {
  const { system, id } = gameIdentity(key);
  return join(cacheDirectory, 'captures', system, id);
}
export function gameSourceDirectory(key: GameKey): string {
  const { system, id } = gameIdentity(key);
  return join(repositoryRoot, 'src/games', system, id);
}
