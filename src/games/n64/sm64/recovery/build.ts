import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../../../core.js';
import { Diagnostic } from '../../../../contracts.js';
import { repositoryRoot, gameBuildDirectory } from '../../../../paths.js';
import type { StartupOptions } from '../../../../startup.js';
import type { N64Launch, N64Checkpoint } from '../../../../systems/n64/checkpoint.js';
import { liftVr4300Pages, type Vr4300Instruction } from '../../../../transpiler/vr4300.js';
import { emitVr4300Blocks } from '../../../../transpiler/vr4300-blocks.js';
import { liftRsp, type RspInstruction } from '../../../../transpiler/rsp.js';
import { programFiles } from '../../../../transpiler/static.js';
import { verifyWebImports } from '../../../../build/web-imports.js';
import { loadSm64Capture, prepareSm64Playback, type Sm64PlaybackOptions } from './playback.js';
import { assertSourceSnapshot } from '../../../../analysis/source-snapshot.js';

/** N64 packaging owns no CPU decoder at runtime. The browser gets original
 * instruction functions, exact captured launch memories and its worker UI. */
export async function buildSm64Web(options: Sm64PlaybackOptions = {}) {
  const prepared = await prepareSm64Playback(options);
  return packageSm64Playback(prepared, options);
}

/** Build: package the saved recovery capture with the current code, without
 * re-verifying. The manifest marks verification stale unless the capture was
 * verified for these exact sources; `verify-game` refreshes it. */
export async function packageSm64Web(options: Sm64PlaybackOptions = {}) {
  const capture = await loadSm64Capture(options);
  options.onProgress?.(
    capture.current
      ? 'Packaging SM64 from the capture verified for the current sources…'
      : `Packaging SM64 from capture ${capture.record.fingerprint.slice(0, 8)}…; verification is stale until npm run cli -- verify-game n64/sm64.`,
  );
  return packageSm64Playback(capture, { ...options, verified: capture.current });
}

/** Package a capture separately from the expensive recovery. This also lets
 * browser and delivery tests exercise the exact same export. */
export async function packageSm64Playback(
  prepared: Awaited<ReturnType<typeof prepareSm64Playback>>,
  options: StartupOptions & { verified?: boolean } = {},
) {
  const verified = options.verified ?? true;
  if (verified) {
    if (!prepared.record.sourceSnapshot) {
      throw new Diagnostic(
        'SM64_MODEL_SNAPSHOT',
        'Use an earlier capture as a declared fixture and reverify the current model before packaging.',
      );
    }
    await assertSourceSnapshot(prepared.record.sourceSnapshot);
  }
  const directory = resolve(options.outputDirectory ?? gameBuildDirectory('n64/sm64'));
  const compiled = fileURLToPath(new URL('../../../../', import.meta.url));
  const files: Record<string, string> = {},
    sources = new Map<string, string>();
  const put = async (name: string, bytes: Uint8Array | string) => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes);
    files[name] = sha256(bytes);
    if (name.endsWith('.js')) {
      sources.set(name, typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString());
    }
  };
  const asset = async (bytes: Uint8Array, extension = 'bin') => {
    const name = `assets/${sha256(bytes)}.${extension}`;
    await put(name, bytes);
    return name;
  };
  const launch: N64Launch = {
    schemaVersion: 1,
    state: JSON.parse(Buffer.from(prepared.files['title.json']!).toString()) as N64Checkpoint,
    assets: {
      cartridge: await asset(prepared.media.rom),
      rdram: await asset(prepared.files['rdram.bin']!),
      signal: await asset(prepared.files['signal.bin']!),
    },
    cartridgeSha256: prepared.media.identity.canonicalSha256,
    width: 320,
    height: 240,
  };
  await put('checkpoint.json', JSON.stringify(launch));
  await put('reference-final.png', prepared.files['title.png']!);
  await put('package.json', JSON.stringify({ type: 'module' }));
  const cpuInstructions = JSON.parse(
    Buffer.from(prepared.files['cpu.json']!).toString(),
  ) as Vr4300Instruction[];
  const cpu = liftVr4300Pages(cpuInstructions);
  // Play tier: compiled basic blocks of the same recovered instructions.
  for (const [name, source] of Object.entries(emitVr4300Blocks(cpuInstructions).files)) {
    await put('game-code/' + name, source);
  }
  const rsp = liftRsp(
    JSON.parse(Buffer.from(prepared.files['rsp.json']!).toString()) as RspInstruction[],
  );
  for (const [folder, program] of [
    ['game-code/', cpu],
    ['game-code/rsp-play/', rsp],
  ] as const) {
    for (const [name, source] of Object.entries(programFiles(program, true))) {
      await put(
        folder + name,
        folder === 'game-code/rsp-play/' && name.endsWith('.ts')
          ? source.replace("'../runtime/rsp.js'", "'../../runtime/rsp.js'")
          : source,
      );
    }
  }
  for (const [processor, folder] of [
    ['cpu', 'game-code/'],
    ['rsp', 'game-code/rsp-play/'],
  ] as const) {
    const observations = JSON.parse(
      Buffer.from(prepared.files[processor + '-observed.json']!).toString(),
    ) as unknown[];
    const parts: string[] = [];
    if (observations.length > 1000) {
      for (let offset = 0; offset < observations.length; offset += 1000) {
        const name = `observations/${(offset / 1000).toString(16).padStart(4, '0')}.json`;
        await put(folder + name, JSON.stringify(observations.slice(offset, offset + 1000)));
        parts.push(name);
      }
    }
    await put(
      folder + 'observed-source.json',
      JSON.stringify({
        schemaVersion: 1,
        architecture: processor === 'cpu' ? 'mips3-vr4300' : 'n64-rsp',
        scope:
          'Original title-to-opening execution, checked by fresh static CPU/RSP replay. Unvisited instruction words from declared memory ranges broaden coverage but are not observations. Hardware parity and full gameplay remain unverified.',
        observationCount: observations.length,
        mappings: parts.length ? [] : observations,
        ...(parts.length ? { parts } : {}),
      }),
    );
  }
  // Keep the independently checked bounded studies alongside the larger
  // interactive program. Running boot analyses never overwrites this player.
  const studyDirectory = join(gameBuildDirectory('n64/sm64'), 'analysis/startup/source-study');
  const study = JSON.parse(await readFile(join(studyDirectory, 'manifest.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  for (const [name, hash] of Object.entries(study.files)) {
    if (!/^game-code\/(?:[a-z0-9-]+\/)?(?:program\.ts|observed-source\.json)$/.test(name)) {
      continue;
    }
    const bytes = await readFile(join(studyDirectory, name));
    if (sha256(bytes) !== hash) {
      throw new Diagnostic('SM64_STUDY_HASH', `Changed bounded source study: ${name}.`);
    }
    const target = name.startsWith('game-code/rsp')
      ? name
      : name.replace('game-code/', 'game-code/cpu-startup/');
    await put(target, bytes);
  }
  const modules = [
    'contracts',
    'web/audio',
    'web/keyboard',
    ...[
      'vr4300',
      'vr4300-control',
      'vr4300-fpu',
      'binary-float',
      'register-words',
      'vr4300-memory',
      'rsp',
      'rsp-vector',
      'rsp-reciprocal',
    ].map((name) => 'runtime/' + name),
    ...[
      'system',
      'memory',
      'interrupts',
      'video',
      'peripheral',
      'serial',
      'audio',
      'signal',
      'display',
      'texture',
      'rdp-triangle',
      'rdp-pixels',
      'rdp-combiner',
      'rdp-span-pixels',
      'render',
      'input',
      'checkpoint',
      'player',
      // Play tier: high-level Fast3D tasks and the parallel RDP stream.
      'fast3d',
      'rdp-stream',
    ].map((name) => 'systems/n64/' + name),
    ...['app', 'worker', 'rdp-worker', 'protocol'].map((name) => 'systems/n64/web/' + name),
    'games/n64/sm64/web/title',
  ];
  for (const name of modules) {
    await put(name + '.js', await readFile(join(compiled, name + '.js')));
    if (name.startsWith('runtime/')) {
      await put(name + '.d.ts', await readFile(join(compiled, name + '.d.ts')));
    }
  }
  await put(
    'index.html',
    (await readFile(join(repositoryRoot, 'src/web/index.html'), 'utf8')).replace(
      './web/app.js',
      './systems/n64/web/app.js',
    ),
  );
  await put('style.css', await readFile(join(repositoryRoot, 'src/web/style.css')));
  for (const [name, source] of [
    ['README.md', 'README.md'],
    ['STARTUP.md', 'docs/STARTUP.md'],
    ['CPU.md', 'docs/CPU.md'],
    ['AUDIO.md', 'docs/AUDIO.md'],
    ['GRAPHICS.md', 'docs/GRAPHICS.md'],
  ]) {
    await put(
      'learn/' + name!,
      await readFile(join(repositoryRoot, 'src/games/n64/sm64', source!)),
    );
  }
  verifyWebImports(sources);
  if (verified) {
    await assertSourceSnapshot(prepared.record.sourceSnapshot!);
  }
  const manifest = {
    schemaVersion: 2,
    titleId: 'sm64',
    gameKey: 'n64/sm64',
    system: 'n64',
    build: { status: 'partial-title', playable: true, artifact: 'static-n64-worker-study' },
    backend: {
      cpu: 'mips3-vr4300',
      signalProcessor: 'n64-rsp',
      execution: 'static-original-instruction-functions',
      scheduling: 'dedicated-browser-worker',
    },
    verification: verified
      ? prepared.record.verification
      : {
          ...prepared.record.verification,
          referenceReplay: 'stale',
          currentSource: `Packaged with current code from capture ${prepared.record.fingerprint}; not verified for these sources.`,
        },
    recovery: {
      sourceFingerprint: prepared.record.fingerprint,
      modelSourceFiles: Object.keys(prepared.record.sourceSnapshot?.files ?? {}).length,
      modelSourceFingerprint: sha256(JSON.stringify(prepared.record.sourceSnapshot ?? null)),
      origin: prepared.record.origin ?? { kind: 'earlier recorded startup' },
      checkedFullSyncs: [prepared.record.title.fullSyncs, prepared.record.end.fullSyncs],
      scope:
        prepared.record.origin?.kind === 'earlier-verified-original-endpoint'
          ? 'Current static title-to-opening execution compared with an explicitly captured earlier original endpoint and PCM; original recovery was not rerun under the current source.'
          : 'Captured original title through opening; broader live play requires separate acceptance.',
    },
    launch: {
      origin: 'original captured title',
      consoleReset: 'unverified',
      ticks: prepared.record.title.ticks,
    },
    shell: {
      kind: 'n64-worker-shell',
      runtime: 'vr4300-rsp-static',
      titleModule: '../games/n64/sm64/web/title.js',
      inputFormat: 'n64-controller',
    },
    media: prepared.media.identity,
    example: { controlFrames: 0, completion: false },
    exportId: sha256(JSON.stringify(files)),
    files,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outputDirectory: directory, manifest };
}
