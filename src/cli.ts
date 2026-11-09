#!/usr/bin/env node
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, VERSION } from './core.js';
import { D64Image } from './media/d64.js';
import { AddressSpace } from './memory.js';
import { basicSys } from './media/basic.js';
import { disassemble, listing } from './transpiler/mos6502.js';
import { lift } from './transpiler/lift.js';
import { runTrial } from './games/c64/lemmings/recovery/trial.js';
import { readBounded } from './files.js';
import { recoverTrial } from './games/c64/lemmings/recovery/recover.js';
import { levelTrial } from './games/c64/lemmings/recovery/level.js';
import { digTrial, type DiggerInput } from './games/c64/lemmings/recovery/dig.js';
import { serveWeb } from './build/serve.js';
import { titles, resolveTitleId } from './titles.js';
import { buildSite } from './build/site.js';
import { rebuildQueue } from './build/rebuild.js';
import { siteDirectory, workDirectory } from './paths.js';
import { watch } from 'node:fs';
import { bundleMedia, importMedia } from './cli/media-bundle.js';
import { identifyPaths, describeIdentification } from './cli/identify.js';
import { bootSm64Graphics } from './games/n64/sm64/recovery/graphics.js';

const usage = `ROM Studio ${VERSION} — understand old games, build for the web

Start with the original bytes:
  roms identify <file-or-folder...> [--json]
      Inspect formats, systems, hashes and matching game recipes.
      Example: roms identify roms/c64/elite/ELITE-E.D64
      Example: roms identify roms/nes

Build and play:
  roms dev [--port 4170]                Serve the system → game library
  roms build [--domain <host>] [--base /path/] [--deploy]  Build game packages and dist/site
  roms build-game <system/game>        Package one game with the current code
  roms verify-game <system/game>       Rerun recovery and original/static verification
  roms preview [--port 4170]            Serve the existing static site

CI media inputs:
  roms media bundle [--out <file>]      Prepare the pinned inputs for CI
  roms media import <bundle.json.gz>    Verify and restore exact recipe inputs

Explore the assembly:
  roms extract <disk.d64> --out <dir>   Extract files with source offsets
  roms disassemble <game.prg> [--entry <address>]
  roms lift <game.prg> --out <dir> [--entry <address>]
      Emit guarded TypeScript, JavaScript and source mappings.

Game recovery stages:
  roms boot [--title <game>]             Verify the target's declared startup stage
  roms boot --title n64/sm64 --until graphics  Verify the first original graphics clear task
  roms boot --title n64/sm64 --until textures  Verify texture loading up to the first unrendered triangle
  roms boot --title n64/sm64 --until frame     Verify the first rendered original graphics task
  roms trial                           Check the Lemmings bootstrap fixture
  roms verify                          Repeat bootstrap verification
  roms recover [--stop <address>]      Recover the bounded unpacker path
  roms level [--number 1|2]             Capture a Lemmings level
  roms dig [--replay <json>]            Verify a complete digger action
  roms play [--title <name>] [--port <n>]  Serve one game package

Recovery accepts --media <dir>, --recipe <json> and --out <dir>.
Addresses: 2060, 0x080c or '$080c'. Identify never executes input code.
Game names can be shortened when unique, or selected with --system <system>.
Use npm run cli -- <command> from this checkout, or install the roms binary.
`;
function argumentsFor(args: string[]): { files: string[]; flags: Record<string, string> } {
  const files: string[] = [],
    flags: Record<string, string> = {};
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]!;
    if (arg === '--json' || arg === '--deploy') {
      if (flags[arg.slice(2)]) {
        throw new Diagnostic('CLI_OPTION', `Duplicate ${arg}.`);
      }
      flags[arg.slice(2)] = 'true';
      continue;
    }
    if (arg.startsWith('--')) {
      if (
        ![
          '--out',
          '--media',
          '--recipe',
          '--entry',
          '--stop',
          '--number',
          '--replay',
          '--port',
          '--title',
          '--system',
          '--base',
          '--domain',
          '--until',
        ].includes(arg)
      ) {
        throw new Diagnostic('CLI_OPTION', `Unknown option ${arg}.`);
      }
      const value = args[++n];
      if (!value || value.startsWith('--') || flags[arg.slice(2)] !== undefined) {
        throw new Diagnostic('CLI_OPTION', `Option ${arg} needs exactly one value.`);
      }
      flags[arg.slice(2)] = value;
    } else {
      files.push(arg);
    }
  }
  return { files, flags };
}
async function main(): Promise<void> {
  const [requestedCommand, ...rest] = process.argv.slice(2);
  let command = requestedCommand;
  if (command === '--version') {
    console.log(VERSION);
    return;
  }
  if (!command || command === '--help' || command === 'help' || rest.includes('--help')) {
    console.log(usage);
    return;
  }
  const { files, flags } = argumentsFor(rest);
  if (flags.until && command !== 'boot') {
    throw new Diagnostic('CLI_OPTION', '--until is a startup recovery option for boot.');
  }
  if (command === 'inspect') {
    command = 'identify';
  }
  if (flags.json && command !== 'identify') {
    throw new Diagnostic('CLI_OPTION', '--json belongs to identify.');
  }
  if (command === 'identify') {
    const reports = await identifyPaths(files);
    console.log(
      flags.json ? JSON.stringify(reports, null, 2) : describeIdentification(reports).trimEnd(),
    );
    return;
  }
  if (command === 'media') {
    if (files[0] === 'bundle' && files.length === 1) {
      const output = resolve(flags.out ?? join(workDirectory, 'rom-studio-media.json.gz'));
      await bundleMedia(output);
      console.log(`Pinned media bundle: ${output}`);
      return;
    }
    if (files[0] === 'import' && files.length === 2) {
      console.log(`Verified ${await importMedia(files[1]!)} pinned media inputs.`);
      return;
    }
    throw new Diagnostic(
      'CLI_INPUT',
      'Use roms media bundle [--out <file>] or roms media import <bundle.json.gz>.',
    );
  }
  if (command === 'build-game' || command === 'verify-game') {
    if (files.length > 1 || (files.length && flags.title)) {
      throw new Diagnostic('CLI_INPUT', `Use ${command} <name> or --title <name>.`);
    }
    if (files[0]) {
      flags.title = files.shift()!;
    }
    if (!flags.title) {
      throw new Diagnostic('CLI_INPUT', 'Choose a game: ' + Object.keys(titles).join(', '));
    }
    // verify-game always recovers and compares; build-game packages from the
    // saved capture when the game supports it.
    const selected = titles[resolveTitleId(flags.title, flags.system)];
    command = command === 'build-game' && 'package' in selected ? 'package' : 'web';
  }
  if (command === 'build' || command === 'dev' || command === 'preview') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', `${command} takes named options only.`);
    }
    const port = flags.port === undefined ? 4170 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Diagnostic('CLI_PORT', 'Port must be an integer from 0 to 65535.');
    }
    const outputDirectory = resolve(
      flags.out ??
        (command === 'dev'
          ? join(workDirectory, port === 4170 ? 'site' : `site-${port}`)
          : siteDirectory),
    );
    if (command !== 'preview') {
      await buildSite({
        outputDirectory,
        rebuild: true,
        includeStudies: flags.deploy !== 'true',
        requireReady: flags.deploy === 'true',
        requireVerified: flags.deploy === 'true',
        ...(flags.base ? { basePath: flags.base } : {}),
        ...(flags.domain ? { domain: flags.domain } : {}),
        onProgress: (message) => console.error(message),
      });
    }
    if (command === 'build') {
      console.log(`Static site: ${outputDirectory}\nDeploy this directory to a static web host.`);
      return;
    }
    if (command === 'dev') {
      await mkdir(join(workDirectory, 'games'), { recursive: true });
    }
    const preview = await serveWeb(outputDirectory, port);
    console.log(
      `ROM Studio library\nLocal: ${preview.url}\nSystem → game → play\nCtrl-C stops the local server.`,
    );
    let pending: ReturnType<typeof setTimeout> | undefined;
    const rebuild = rebuildQueue(
      async () => {
        await buildSite({
          outputDirectory,
          rebuild: true,
          includeStudies: true,
          ...(flags.base ? { basePath: flags.base } : {}),
          ...(flags.domain ? { domain: flags.domain } : {}),
        });
      },
      (error) => console.error((error as Error).message),
    );
    const watcher =
      command === 'dev'
        ? watch(join(workDirectory, 'games'), { recursive: true }, (_event, file) => {
            const name = String(file);
            if (name.split('/').length !== 3 || !name.endsWith('/manifest.json')) {
              return;
            }
            clearTimeout(pending);
            pending = setTimeout(() => {
              rebuild.request();
            }, 250);
          })
        : undefined;
    const stop = () => {
      clearTimeout(pending);
      rebuild.close();
      watcher?.close();
      preview.server.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const selected = resolveTitleId(flags.title ?? 'c64/lemmings', flags.system);
  const title = titles[selected];
  if (
    selected !== 'c64/lemmings' &&
    ['trial', 'verify', 'recover', 'level', 'dig'].includes(command)
  ) {
    throw new Diagnostic(
      'TITLE_STAGE',
      'These legacy recovery stages belong to Lemmings. Use the selected target’s declared boot/build stages.',
    );
  }
  if (command === 'extract') {
    if (files.length !== 1 || !flags.out) {
      throw new Diagnostic('CLI_INPUT', 'extract needs one image and --out directory.');
    }
    const disk = new D64Image(await readBounded(files[0]!, 206114)),
      directory = resolve(flags.out);
    const extracted = disk.entries.map((entry) => ({ entry, file: disk.extract(entry) }));
    await mkdir(directory, { recursive: true });
    const manifest = [];
    for (const { entry, file } of extracted) {
      // Never use untrusted PETSCII names as host filenames.
      const filename = `${entry.id}.${entry.type.toLowerCase()}`;
      await writeFile(join(directory, filename), file.bytes, { flag: 'wx' });
      manifest.push({ ...entry, filename, bytes: file.bytes.length, provenance: file.spans });
    }
    await writeFile(
      join(directory, 'inventory.json'),
      JSON.stringify({ mediaHash: disk.hash, entries: manifest }, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(`Extracted ${manifest.length} files to ${directory}`);
    return;
  }
  if (command === 'disassemble' || command === 'lift') {
    if (files.length !== 1) {
      throw new Diagnostic('CLI_INPUT', `${command} needs one PRG file.`);
    }
    const space = new AddressSpace(),
      load = space.loadPrg(await readBounded(files[0]!, 65538));
    const entry =
      flags.entry === undefined
        ? basicSys(space.bytes, load.start).entry
        : Number(flags.entry.replace(/^\$/, '0x'));
    if (!Number.isInteger(entry) || entry < 0 || entry > 65535) {
      throw new Diagnostic('CLI_ENTRY', 'Entry must be a 16-bit address.');
    }
    const cfg = disassemble(space, [entry]);
    if (command === 'disassemble') {
      console.log(listing(cfg.instructions));
      console.error(JSON.stringify({ unresolved: cfg.unresolved }, null, 2));
      return;
    }
    if (!flags.out) {
      throw new Diagnostic('CLI_INPUT', 'lift needs --out directory.');
    }
    const output = resolve(flags.out),
      generated = lift(cfg.instructions);
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(join(output, 'program.ts'), generated.typescript),
      writeFile(join(output, 'program.js'), generated.javascript),
      writeFile(join(output, 'source-map.json'), JSON.stringify(generated.mappings, null, 2)),
      writeFile(
        join(output, 'gaps.json'),
        JSON.stringify([...cfg.unresolved, ...generated.gaps], null, 2),
      ),
      copyFile(
        fileURLToPath(new URL('./runtime/mos6502.js', import.meta.url)),
        join(output, 'runtime.js'),
      ),
      copyFile(
        fileURLToPath(new URL('./runtime/mos6502.d.ts', import.meta.url)),
        join(output, 'runtime.d.ts'),
      ),
    ]);
    console.log(`Lifted ${cfg.instructions.length} instructions to ${output}`);
    return;
  }
  if (command === 'trial' || command === 'verify') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', `${command} takes named options only.`);
    }
    const result = await runTrial({
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      ...(flags.out ? { outputDirectory: flags.out } : {}),
    });
    console.log(
      JSON.stringify(
        {
          build: result.manifest.build,
          verification: result.manifest.verification,
          output: result.outputDirectory,
          checks: result.verification.checks,
        },
        null,
        2,
      ),
    );
    if (result.verification.status !== 'passed') {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'recover') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', 'recover takes named options only.');
    }
    const result = await recoverTrial({
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      ...(flags.out ? { outputDirectory: flags.out } : {}),
      ...(flags.stop ? { stopAt: Number(flags.stop.replace(/^\$/, '0x')) } : {}),
    });
    console.log(
      JSON.stringify(
        {
          output: result.outputDirectory,
          status: result.report.status,
          stop: result.report.stop,
          gap: result.report.gap,
          state: result.report.state,
          snapshotHash: result.report.snapshotHash,
          observed: result.report.observed,
          verification: result.report.verification,
        },
        null,
        2,
      ),
    );
    if (result.report.stop !== 'checkpoint') {
      process.exitCode = 2;
    }
    return;
  }
  if (command === 'web' || command === 'package' || command === 'play') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', `${command} takes named options only.`);
    }
    const outputDirectory = resolve(flags.out ?? title.webDirectory);
    const options = {
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      outputDirectory,
      onProgress: (message: string) => console.error(message),
    };
    if (command === 'web' || command === 'package') {
      const result =
        command === 'package' && 'package' in title
          ? await title.package(options)
          : await title.web(options);
      console.log(
        JSON.stringify(
          {
            output: result.outputDirectory,
            build: result.manifest.build,
            verification: result.manifest.verification,
            backend: result.manifest.backend,
          },
          null,
          2,
        ),
      );
    } else {
      let needsBuild: boolean;
      try {
        const manifest = JSON.parse(
          (await readBounded(join(outputDirectory, 'manifest.json'), 1048576)).toString(),
        ) as { build?: { playable?: boolean }; files?: Record<string, string> };
        needsBuild = !manifest.build?.playable || !manifest.files?.['index.html'];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        needsBuild = true;
      }
      if (needsBuild) {
        await title.web(options);
      }
      const preview = await serveWeb(
        outputDirectory,
        flags.port === undefined ? title.defaultPort : Number(flags.port),
      );
      console.log(
        `ROM Studio · ${title.name}\nLocal: ${preview.url}\n${title.controls}\nCtrl-C stops the local server.`,
      );
      process.once('SIGINT', () => {
        preview.server.close();
      });
      process.once('SIGTERM', () => {
        preview.server.close();
      });
    }
    return;
  }
  if (command === 'dig') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', 'dig takes named options only.');
    }
    const inputReplay = flags.replay
      ? (JSON.parse((await readBounded(flags.replay, 1048576)).toString()) as DiggerInput[])
      : undefined;
    const result = await digTrial({
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      ...(flags.out ? { outputDirectory: flags.out } : {}),
      ...(inputReplay !== undefined ? { inputReplay } : {}),
    });
    console.log(
      JSON.stringify(
        {
          output: result.outputDirectory,
          status: result.report.status,
          skillStock: result.report.skillStock,
          strokeComparisons: result.report.strokeComparisons,
          changedTerrainSamples: result.report.terrainChanges.length,
          firstLemming: result.report.firstLemming,
          verification: result.report.verification,
          gap: result.report.gap,
        },
        null,
        2,
      ),
    );
    if (result.report.status !== 'digger-path-verified') {
      process.exitCode = 2;
    }
    return;
  }
  if (command === 'level') {
    if (files.length || (flags.number !== undefined && !['1', '2'].includes(flags.number))) {
      throw new Diagnostic('CLI_INPUT', 'level takes named options and --number 1 or 2.');
    }
    const result = await levelTrial({
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      ...(flags.out ? { outputDirectory: flags.out } : {}),
      level: flags.number === '2' ? 2 : 1,
    });
    console.log(
      JSON.stringify(
        {
          output: result.outputDirectory,
          status: result.report.status,
          header: result.report.header,
          firstLemming: result.report.firstLemming,
          verification: result.report.verification,
          gap: result.report.gap,
          decodeGap: result.report.decodeGap,
          diskReads: result.report.diskReads.map((read) => read.name),
        },
        null,
        2,
      ),
    );
    if (result.report.status !== 'first-lemming-spawned') {
      process.exitCode = 2;
    }
    return;
  }
  if (command === 'boot') {
    if (files.length) {
      throw new Diagnostic('CLI_INPUT', 'boot takes named options only.');
    }
    if (flags.until) {
      if (!['graphics', 'textures', 'frame'].includes(flags.until) || selected !== 'n64/sm64') {
        throw new Diagnostic(
          'CLI_INPUT',
          'SM64 recovery stages are roms boot --title sm64 --until graphics|textures|frame.',
        );
      }
      const result = await bootSm64Graphics({
        stage:
          flags.until === 'frame' ? 'frame' : flags.until === 'textures' ? 'textures' : 'clear',
        onProgress: (message) => console.error(message),
        ...(flags.media ? { mediaDirectory: flags.media } : {}),
        ...(flags.recipe ? { recipePath: flags.recipe } : {}),
        ...(flags.out ? { outputDirectory: flags.out } : {}),
      });
      console.log(
        JSON.stringify(
          {
            output: result.outputDirectory,
            status: result.report.status,
            capture: result.report.capture,
            verification: result.report.verification,
            instructions: result.report.graphics.instructions,
            shapes: result.report.graphics.shapes,
            fills: result.report.graphics.display.fills,
            ...('boundary' in result.report.graphics
              ? {
                  boundary: result.report.graphics.boundary,
                  texture: result.report.graphics.texture,
                }
              : {}),
            ...('image' in result.report.graphics
              ? {
                  image: result.report.graphics.image,
                  triangles: result.report.graphics.display.triangles.length,
                }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!('boot' in title)) {
      throw new Diagnostic(
        'TITLE_STAGE',
        'Use build-game for this cartridge study; it starts from the original reset vector.',
      );
    }
    const result = await title.boot({
      ...(flags.media ? { mediaDirectory: flags.media } : {}),
      ...(flags.recipe ? { recipePath: flags.recipe } : {}),
      ...(flags.out ? { outputDirectory: flags.out } : {}),
    });
    console.log(
      JSON.stringify(
        {
          output: result.outputDirectory,
          status: result.report.status,
          state: result.report.state,
          verification: result.report.verification,
          gap: 'gap' in result.report ? result.report.gap : undefined,
          renderGap: 'renderGap' in result.report ? result.report.renderGap : undefined,
          diskReads:
            'diskReads' in result.report
              ? result.report.diskReads.map((read) => read.name)
              : undefined,
          fixture: 'fixture' in result.report ? result.report.fixture : undefined,
          timingModel: 'timingModel' in result.report ? result.report.timingModel : undefined,
          startup: 'startup' in result.report ? result.report.startup : undefined,
          boundary: 'boundary' in result.report ? result.report.boundary : undefined,
          audioTask:
            'audio' in result.report
              ? {
                  status: result.report.audio.status,
                  instructions: result.report.audio.instructions,
                  shapes: result.report.audio.shapes,
                  namedMixer: result.report.audio.namedMixer,
                  verification: result.report.audio.verification,
                }
              : undefined,
        },
        null,
        2,
      ),
    );
    if (result.report.status !== title.bootStage) {
      process.exitCode = 2;
    }
    return;
  }
  throw new Diagnostic('CLI_COMMAND', `Unknown command '${command}'. Run roms --help.`);
}
await main().catch((error) => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const port = (error as NodeJS.ErrnoException & { port?: number }).port ?? 4170;
    const alternative = port === 4175 ? 4176 : 4175;
    console.error(
      `CLI_PORT: http://127.0.0.1:${port} is already in use. Open that URL, stop its server, or run npm run dev -- --port ${alternative}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    `${error instanceof Diagnostic ? error.code : 'ROM_STUDIO_ERROR'}: ${(error as Error).message}`,
  );
  process.exitCode = 1;
});
