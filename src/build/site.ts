import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';
import { repositoryRoot, siteDirectory, gameBuildDirectory } from '../paths.js';
import { gameLearning } from './learn.js';
import { titles, requiredReleaseGames, type TitleId } from '../titles.js';
import { gameDelivery, requireReadyGames } from './delivery.js';
import { gameSources } from '../game-library.js';
export interface CatalogGame {
  id: string;
  name: string;
  system: string;
  runnable: boolean;
  experimental: boolean;
  status: string;
  entry?: string;
  codeDirectory?: string;
  codeSources?: { id: string; label: string; directory: string }[];
  image?: string;
  exportId?: string;
  learning: string;
  media: { name: string; sha256: string; bytes: number; asset: string }[];
}
/** Assemble a static deployment from verified game files and content-addressed
 * source media. Recovery traces and tool/test code never enter this directory. */
export async function buildSite(
  options: {
    outputDirectory?: string;
    rebuild?: boolean;
    basePath?: string;
    domain?: string;
    includeStudies?: boolean;
    requireReady?: boolean;
    /** Deploy: every package must have passed verification for its sources. */
    requireVerified?: boolean;
    onProgress?: (message: string) => void;
  } = {},
) {
  const directory = resolve(options.outputDirectory ?? siteDirectory);
  const basePath = options.basePath ?? '/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)) {
    throw new Diagnostic(
      'SITE_BASE',
      'Base must be a root-relative folder path ending in /, for example /romstudio/.',
    );
  }
  if (
    options.domain &&
    (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(options.domain) || basePath !== '/')
  ) {
    throw new Diagnostic('SITE_DOMAIN', 'A custom domain needs a hostname and the root base /.');
  }
  await mkdir(directory, { recursive: true });
  const sources = await gameSources();
  let oldFiles: Record<string, string> = {};
  try {
    oldFiles =
      JSON.parse((await readBounded(join(directory, 'manifest.json'), 1048576)).toString()).files ??
      {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const routes = new Set(['']);
  const files: Record<string, string> = {},
    games: CatalogGame[] = [];
  const put = async (relative: string, bytes: Uint8Array | string): Promise<void> => {
    await mkdir(dirname(join(directory, relative)), { recursive: true });
    await writeFile(join(directory, relative), bytes);
    files[relative] = sha256(bytes);
  };
  for (const { id, key, recipe } of sources) {
    const installed = Object.hasOwn(titles, key) ? titles[key as TitleId] : undefined;
    const game: CatalogGame = {
      id,
      name: installed?.name ?? recipe.title ?? id,
      system: recipe.system,
      runnable: false,
      experimental: true,
      status: 'Not built yet',
      learning: `learning/${key}.json`,
      media: [],
    };
    const gameRoute = `${recipe.system}/${id}`;
    routes.add(recipe.system);
    routes.add(gameRoute);
    routes.add(gameRoute + '/learn');
    routes.add(gameRoute + '/learn/code');
    const learning = await gameLearning(key, basePath + gameRoute);
    for (const chapter of learning.chapters) {
      routes.add(gameRoute + '/learn/' + chapter.slug);
    }
    await put(game.learning, JSON.stringify(learning));
    const mediaDirectory = recipe.mediaDirectory
      ? join(repositoryRoot, recipe.mediaDirectory)
      : installed!.mediaDirectory;
    for (const medium of recipe.media) {
      if (
        !/^[a-f0-9]{64}$/.test(medium.sha256) ||
        medium.name.includes('/') ||
        medium.name.includes('\\')
      ) {
        throw new Diagnostic('SITE_MEDIA', 'Invalid recipe media identity.');
      }
      let bytes: Buffer;
      try {
        bytes = await readBounded(join(mediaDirectory, medium.name), 16777216);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        if (options.rebuild) {
          throw new Diagnostic(
            'SITE_MEDIA',
            `Missing original media for ${id}: ${medium.name}. See docs/ROMS.md or import the approved pinned media bundle.`,
          );
        }
        game.status = 'Original media needed';
        continue;
      }
      if (sha256(bytes) !== medium.sha256) {
        throw new Diagnostic('MEDIA_HASH', `SHA-256 mismatch for ${medium.name}.`);
      }
      const asset = `assets/roms/${medium.sha256}.${medium.role ?? 'disk'}.bin`;
      await put(asset, bytes);
      game.media.push({ name: medium.name, sha256: medium.sha256, bytes: bytes.length, asset });
    }
    if (installed) {
      try {
        const source = gameBuildDirectory(key),
          manifestBytes = await readBounded(join(source, 'manifest.json'), 1048576);
        const manifest = JSON.parse(manifestBytes.toString()) as {
          titleId: string;
          system: string;
          gameKey?: string;
          exportId: string;
          build: { playable: boolean; status: string };
          verification: { referenceReplay: string };
          files: Record<string, string>;
        };
        if (
          manifest.system !== recipe.system ||
          manifest.titleId !== id ||
          (manifest.gameKey !== undefined && manifest.gameKey !== key)
        ) {
          throw new Diagnostic('SITE_GAME', `Game package identity does not match ${key}.`);
        }
        // Local builds may package from an earlier capture (stale) or skip the
        // comparison (not-run); deployment requires verification passed for the
        // current sources.
        const replay = manifest.verification.referenceReplay;
        if (
          (replay !== 'passed' &&
            (options.requireVerified || (replay !== 'stale' && replay !== 'not-run'))) ||
          !manifest.files['game-code/program.ts'] ||
          !manifest.files['game-code/observed-source.json'] ||
          (manifest.build.playable && !manifest.files['index.html'])
        ) {
          throw new Diagnostic('SITE_GAME', `${id} has no verified game or code-study export.`);
        }
        const prefix = `games/${recipe.system}/${id}/`;
        const sourceDirectories = Object.keys(manifest.files)
          .filter((name) => /^game-code\/[a-z0-9-]+\/observed-source\.json$/.test(name))
          .map((name) => name.slice(0, -'observed-source.json'.length))
          .filter((name) => manifest.files[name + 'program.ts']);
        const codeSources = sourceDirectories.map((directory) => {
          const id = directory.split('/')[1]!;
          routes.add(gameRoute + '/learn/code-' + id);
          return {
            id,
            label:
              id
                .split('-')
                .map((part, index) => (index === 0 ? part.toUpperCase() : part))
                .join(' ') + ' assembly → TypeScript',
            directory: prefix + directory,
          };
        });
        const delivery = gameDelivery(manifest.build.status, options.includeStudies);
        const runtime = delivery.runtime && manifest.build.playable;
        for (const [relative, hash] of Object.entries(manifest.files)) {
          // Public Learn keeps original-code evidence. Experimental execution
          // modules, checkpoints and input logs require an explicit opt-in.
          if (!delivery.includes(relative)) {
            continue;
          }
          const path = resolve(source, relative);
          if (
            !path.startsWith(resolve(source) + sep) ||
            relative.includes('\\') ||
            relative.split('/').some((part) => part === '..' || part.startsWith('.')) ||
            (await lstat(path)).isSymbolicLink()
          ) {
            throw new Diagnostic('SITE_FILE', 'Invalid game export path.');
          }
          const bytes = await readBounded(path, 16777216);
          if (sha256(bytes) !== hash) {
            throw new Diagnostic('SITE_HASH', `Changed game file: ${id}/${relative}.`);
          }
          await put(prefix + relative, bytes);
        }
        if (runtime) {
          await put(prefix + 'manifest.json', manifestBytes);
        }
        Object.assign(game, {
          runnable: runtime,
          experimental: delivery.experimental,
          status:
            manifest.build.status === 'release-ready' ? 'Ready to play' : 'Experimental study',
          ...(runtime ? { entry: prefix + 'index.html' } : {}),
          codeDirectory: prefix + 'game-code/',
          ...(codeSources.length ? { codeSources } : {}),
          ...(manifest.files['reference-final.png']
            ? { image: prefix + 'reference-final.png' }
            : {}),
          exportId: manifest.exportId,
        });
      } catch (error) {
        if (options.rebuild || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    games.push(game);
  }
  if (options.requireReady) {
    requireReadyGames(
      requiredReleaseGames.map((id) => {
        const game = games.find((game) => `${game.system}/${game.id}` === id);
        return game ? { ...game, id } : { id, runnable: false, experimental: true };
      }),
    );
  }
  const catalog = {
    systems: [
      { id: 'c64', name: 'Commodore 64', description: 'Disks, sprites and the SID.' },
      {
        id: 'nes',
        name: 'Nintendo Entertainment System',
        description: 'Cartridges, tiles and a serial controller.',
      },
      {
        id: 'n64',
        name: 'Nintendo 64',
        description: 'MIPS instructions, signal processing and 3D worlds.',
      },
    ],
    games,
  };
  const compiled = fileURLToPath(new URL('../web/library/', import.meta.url));
  await put(
    'index.html',
    (await readFile(join(repositoryRoot, 'src/web/library/index.html'), 'utf8')).replaceAll(
      '__ROM_STUDIO_BASE__',
      basePath,
    ),
  );
  await put('style.css', await readFile(join(repositoryRoot, 'src/web/library/style.css')));
  await put('player-embed.css', await readFile(join(repositoryRoot, 'src/web/embed.css')));
  for (const name of ['app.js', 'router.js', 'code.js']) {
    await put(name, await readFile(join(compiled, name)));
  }
  await put(
    '404.html',
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>ROM Studio</title><p>Opening ROM Studio…</p><script src="${basePath}pages-redirect.js"></script></html>`,
  );
  await put(
    'pages-redirect.js',
    `const base=${JSON.stringify(basePath)};location.replace(base+'?route='+encodeURIComponent(location.pathname+location.search));`,
  );
  if (options.domain) {
    await put('CNAME', options.domain + '\n');
  }
  await put('catalog.json', JSON.stringify(catalog, null, 2) + '\n');
  const manifest = {
    schemaVersion: 1,
    kind: 'romstudio-static-library',
    exportId: sha256(JSON.stringify(files)),
    routing: { basePath, paths: [...routes] },
    verification: {
      referenceReplay: 'passed',
      scope:
        'Executable study packages checked on documented routes. Reference replay is separate from release readiness.',
    },
    media: games.flatMap((game) => game.media.map((medium) => ({ game: game.id, ...medium }))),
    files,
  };
  for (const stale of Object.keys(oldFiles)) {
    if (!Object.hasOwn(files, stale)) {
      const path = resolve(directory, stale);
      if (path.startsWith(directory + sep) && !stale.includes('\\')) {
        await rm(path, { force: true });
      }
    }
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  options.onProgress?.(
    `Static library: ${games.filter((game) => game.runnable && !game.experimental).length} ready games, ${games.filter((game) => game.runnable && game.experimental).length} experimental studies, ${games.length} installed titles.`,
  );
  return { outputDirectory: directory, manifest, catalog };
}
