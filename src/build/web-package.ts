import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../core.js';
import { repositoryRoot } from '../paths.js';
import { encodePng } from '../png.js';
import type { emitRecoveredProgram } from '../transpiler/program.js';
import { verifyWebImports } from './web-imports.js';
import { programFiles } from '../transpiler/static.js';

/** ROM Desk, shared by every package (docs/DESK.md). */
export const deskModules = [
  'web/desk/view.js',
  'web/desk/panel.js',
  'web/desk/observations.js',
  'web/desk/diagram.js',
  'web/desk/mos6502.js',
  'web/library/code.js',
];

/** A game's documented routine names for Desk, if it has any. */
export async function deskSymbols(gameKey: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(repositoryRoot, 'src/games', gameKey, 'desk/symbols.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

const browserModules = [
  'contracts.js',
  'memory.js',
  'runtime/mos6502.js',
  'runtime/mos6502.d.ts',
  'runtime/controls.js',
  'runtime/frame.js',
  'web/keyboard.js',
  'web/shell-types.js',
  'web/titles.js',
  'web/audio.js',
  'web/app.js',
  ...deskModules,
];

/** One static shell and package contract for every supported system. Title builders
 * supply checkpoints, verified instructions, recorded controls and learning files. */
export async function packageWeb<Manifest extends object>(options: {
  directory: string;
  titleId: string;
  manifest: Manifest;
  checkpoint: unknown;
  system: {
    id: string;
    runtime: string;
    inputFormat: string;
    width: number;
    height: number;
    modules: readonly string[];
  };
  program: ReturnType<typeof emitRecoveredProgram>;
  inputs: unknown;
  pixels: Uint8Array;
  titleModules: readonly string[];
  learning: { source: string; relative: string }[];
}) {
  const { directory, program } = options,
    sourceDirectory = fileURLToPath(new URL('../', import.meta.url));
  const modules = [...browserModules, ...options.system.modules, ...options.titleModules];
  const generatedFiles = programFiles(program, true);
  const symbols = await deskSymbols(`${options.system.id}/${options.titleId}`);
  const files = [
    ...(symbols ? ['desk/symbols.json'] : []),
    ...modules,
    'index.html',
    'style.css',
    ...Object.keys(generatedFiles).map((name) => 'game-code/' + name),
    'package.json',
    'checkpoint.json',
    'example.json',
    'game-code/shapes.json',
    'game-code/observed-source.json',
    'reference-final.png',
    ...options.learning.map((file) => file.relative),
  ];
  for (const relative of files) {
    await mkdir(dirname(join(directory, relative)), { recursive: true });
  }
  await Promise.all([
    ...modules.map((relative) =>
      copyFile(join(sourceDirectory, relative), join(directory, relative)),
    ),
    copyFile(join(repositoryRoot, 'src/web/index.html'), join(directory, 'index.html')),
    copyFile(join(repositoryRoot, 'src/web/style.css'), join(directory, 'style.css')),
    ...options.learning.map((file) => copyFile(file.source, join(directory, file.relative))),
    ...Object.entries(generatedFiles).map(([name, source]) =>
      writeFile(join(directory, 'game-code', name), source),
    ),
    writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' })),
    ...(symbols ? [writeFile(join(directory, 'desk/symbols.json'), symbols)] : []),
    writeFile(join(directory, 'checkpoint.json'), JSON.stringify(options.checkpoint)),
    writeFile(join(directory, 'example.json'), JSON.stringify(options.inputs)),
    writeFile(join(directory, 'game-code/shapes.json'), JSON.stringify(program.shapes)),
    writeFile(
      join(directory, 'game-code/observed-source.json'),
      JSON.stringify({
        schemaVersion: 1,
        sample: 'first-observed-variant-per-address-and-opcode',
        mappings: program.observations,
      }),
    ),
    writeFile(
      join(directory, 'reference-final.png'),
      encodePng(options.system.width, options.system.height, options.pixels),
    ),
  ]);
  verifyWebImports(
    new Map(
      await Promise.all(
        [
          ...modules.filter((name) => name.endsWith('.js')),
          ...Object.keys(generatedFiles)
            .filter((name) => name.endsWith('.js'))
            .map((name) => 'game-code/' + name),
        ].map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
      ),
    ),
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(
        async (relative) => [relative, sha256(await readFile(join(directory, relative)))] as const,
      ),
    ),
  );
  const manifest = {
    ...options.manifest,
    schemaVersion: 2,
    titleId: options.titleId,
    gameKey: `${options.system.id}/${options.titleId}`,
    exportId: sha256(JSON.stringify(hashes)),
    system: options.system.id,
    shell: {
      kind: 'shared-browser-shell',
      runtime: options.system.runtime,
      titleModule: `../games/${options.system.id}/${options.titleId}/web/title.js`,
      inputFormat: options.system.inputFormat,
    },
    files: hashes,
    assets: { policy: 'included-in-static-build', publication: 'separate-from-build' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
