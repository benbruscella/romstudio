import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Diagnostic } from './contracts.js';
import { readBounded } from './files.js';
import { repositoryRoot } from './paths.js';
import { gameKey } from './game-id.js';

export interface GameRecipeSummary {
  title: string;
  system: string;
  mediaDirectory?: string;
  media: { name: string; sha256: string; role?: string }[];
}
/** One source-owned discovery path for the library, media bundles and identify. */
export async function gameSources(root = join(repositoryRoot, 'src/games')) {
  const result = [];
  for (const system of (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const game of (await readdir(join(root, system.name), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const key = gameKey(system.name, game.name);
      const directory = join(root, system.name, game.name);
      const recipe = JSON.parse(
        (await readBounded(join(directory, 'recipe.json'), 65536)).toString(),
      ) as GameRecipeSummary;
      if (recipe.system !== system.name || !Array.isArray(recipe.media)) {
        throw new Diagnostic(
          'GAME_RECIPE',
          `${key}/recipe.json must declare system '${system.name}' and media.`,
        );
      }
      result.push({ key, id: game.name, system: system.name, directory, recipe });
    }
  }
  return result;
}
