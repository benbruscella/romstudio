import { join, resolve, sep } from 'node:path';
import { Diagnostic } from '../core.js';
import { repositoryRoot } from '../paths.js';
import { gameSources } from '../game-library.js';

export interface PinnedMedium {
  id: string;
  game: string;
  title: string;
  system: string;
  name: string;
  role: string;
  sha256: string;
  path: string;
}
/** Source-owned identities, independent of whether a game's builder is ready. */
export async function pinnedMedia(): Promise<PinnedMedium[]> {
  const result: PinnedMedium[] = [];
  for (const { key, recipe } of await gameSources()) {
    if (!recipe.mediaDirectory || !Array.isArray(recipe.media)) {
      throw new Diagnostic(
        'MEDIA_RECIPE',
        `Declare mediaDirectory and media in ${key}/recipe.json.`,
      );
    }
    const root = resolve(repositoryRoot, recipe.mediaDirectory);
    if (!root.startsWith(join(repositoryRoot, 'roms') + sep)) {
      throw new Diagnostic('MEDIA_RECIPE', 'Media directories must be inside roms/.');
    }
    for (const medium of recipe.media) {
      if (
        !/^[a-f0-9]{64}$/.test(medium.sha256) ||
        !medium.name ||
        medium.name.includes('/') ||
        medium.name.includes('\\') ||
        medium.name === '.' ||
        medium.name === '..'
      ) {
        throw new Diagnostic('MEDIA_RECIPE', 'Invalid pinned filename or hash.');
      }
      result.push({
        id: key + '/' + medium.name,
        game: key,
        title: recipe.title,
        system: recipe.system,
        name: medium.name,
        role: medium.role ?? 'disk',
        sha256: medium.sha256,
        path: join(root, medium.name),
      });
    }
  }
  return result;
}
