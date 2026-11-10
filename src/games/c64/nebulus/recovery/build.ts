import { c64BrowserPackage } from '../../../../systems/c64/package.js';
import { join, resolve } from 'node:path';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startNebulusGame, nebulusRoutes, nebulusExtensions, type NebulusRoute } from './game.js';
import { repositoryRoot, gameBuildDirectory } from '../../../../paths.js';
import { Diagnostic, sha256 } from '../../../../core.js';
import type { C64Controls, RecordedControls } from '../../../../systems/c64/input.js';
import {
  emitRecoveredProgram,
  recoverStaticBranches,
  writeStaticProgram,
  knownMemoryInstructions,
} from '../../../../transpiler/program.js';
import { packageWeb } from '../../../../build/web-package.js';
import { analyseInProcess } from '../../../../analysis/process.js';
import type { NebulusAnalysisJob, NebulusAnalysisResult } from './analysis-worker.js';
import type { StartupOptions } from '../../../../startup.js';

export const defaultNebulusWebDirectory = gameBuildDirectory('c64/nebulus');
export async function buildNebulusWeb(
  options: StartupOptions & {
    onProgress?: (message: string) => void;
    /** Replay the exported static program against original-instruction traces
     * and assert parity (default true). `npm run build` passes false: packages
     * are identical, only the manifest's verification section reports
     * 'not-run'. `verify-game` and tests keep verifying. */
    verify?: boolean;
  } = {},
) {
  const verify = options.verify ?? true;
  const directory = resolve(options.outputDirectory ?? defaultNebulusWebDirectory);
  options.onProgress?.('Booting Nebulus and entering the first tower');
  const start = await startNebulusGame({
    ...options,
    outputDirectory: join(directory, 'analysis'),
  });
  const checkpoint = start.checkpoint;
  await mkdir(join(directory, 'analysis/routes'), { recursive: true });
  await writeFile(
    join(directory, 'analysis/title-launch.json'),
    JSON.stringify(
      {
        controlFrames: start.player.controlFrames,
        inputs: start.player.inputs,
        fixture: start.launchFixture,
      },
      null,
      2,
    ),
  );
  await writeFile(join(directory, 'analysis/gameplay-checkpoint.json'), JSON.stringify(checkpoint));
  const worker = new URL('./analysis-worker.js', import.meta.url);
  const run = async (route: NebulusRoute, launch = checkpoint, capture = false) => {
    options.onProgress?.(`Recovering Nebulus: ${route.id}`);
    const inputs: RecordedControls[] = [];
    let previous = '';
    for (let frame = 1; frame <= route.frames; frame++) {
      const controls = route.controls(frame),
        text = JSON.stringify(controls);
      if (text !== previous) {
        inputs.push({ frame, ...controls });
      }
      previous = text;
    }
    const data = await analyseInProcess<NebulusAnalysisJob, NebulusAnalysisResult>(worker, {
      checkpoint: launch,
      id: route.id,
      frames: route.frames,
      inputs,
      capture,
    });
    await writeFile(
      join(directory, 'analysis/routes', route.id + '.json'),
      JSON.stringify({
        trace: data.trace,
        fingerprint: data.fingerprint,
        stats: data.stats,
        inputs: data.inputs,
        logicTicks: data.logicTicks,
        waitingToStart: data.waitingToStart,
      }),
    );
    if (!data.trace) {
      throw new Diagnostic('NEBULUS_TRACE', 'Original analysis returned no instruction trace.');
    }
    return {
      route,
      launch,
      capture,
      data,
      trace: data.trace,
      bounds: data.bounds,
      fingerprint: data.fingerprint,
      audio: data.audio,
    };
  };
  const traces: Awaited<ReturnType<typeof run>>[] = [];
  for (const route of nebulusRoutes) {
    traces.push(
      await run(
        route,
        checkpoint,
        ['example', 'two-tunnels', 'walk-then-jump-sound'].includes(route.id),
      ),
    );
  }
  const launchFrames = start.player.controlFrames;
  const launchInput = (frame: number): C64Controls => {
    let current: C64Controls = { joystick: 255, keys: [] };
    for (const input of start.player.inputs) {
      if (input.frame <= frame) {
        current = { joystick: input.joystick, keys: input.keys };
      }
    }
    return current;
  };
  // The browser starts at the actual menu. Fire is supplied only by a user or
  // a recorded example, and native instructions perform game initialization.
  const fromTitle = (id: string): NebulusRoute => {
    const game = nebulusRoutes.find((route) => route.id === id)!;
    return {
      id: `title-${id}`,
      frames: launchFrames + game.frames,
      controls: (frame) =>
        frame <= launchFrames ? launchInput(frame) : game.controls(frame - launchFrames),
    };
  };
  const titleRoutes: NebulusRoute[] = [
    { id: 'title-music', frames: 240, controls: () => ({ joystick: 255, keys: [] }) },
    {
      id: 'title-start',
      frames: launchFrames + 40,
      controls: (frame) =>
        frame <= launchFrames ? launchInput(frame) : { joystick: 255, keys: [] },
    },
    fromTitle('example'),
    fromTitle('two-tunnels'),
  ];
  for (const route of titleRoutes) {
    traces.push(await run(route, start.menuCheckpoint, true));
  }
  const decodeOptions = { undocumentedOpcodes: nebulusExtensions };
  const controlFlow = recoverStaticBranches(
    checkpoint,
    traces.flatMap((trace) => trace.trace.variants.map((variant) => variant.address)),
    // Original drawing helpers extend into $C000 and the SID driver lives at
    // $F000. Follow their direct calls too, retaining known-byte checks.
    { start: 0x8000, end: 0x10000 },
    decodeOptions,
  );
  const program = emitRecoveredProgram(
    [start.trace, ...traces.map((trace) => trace.trace)],
    decodeOptions,
    [
      ...controlFlow.instructions,
      ...knownMemoryInstructions(
        start.checkpoint,
        { start: 0x0200, end: 0x10000 },
        { undocumentedOpcodes: nebulusExtensions },
      ),
      ...knownMemoryInstructions(
        start.menuCheckpoint,
        { start: 0x0200, end: 0x10000 },
        { undocumentedOpcodes: nebulusExtensions },
      ),
    ],
  );
  await writeStaticProgram(program, join(directory, 'analysis'));
  options.onProgress?.(`Emitting ${program.shapes.length} guarded Nebulus instruction shapes`);
  const checks: { name: string; passed: boolean }[] = [];
  const example = traces.find((trace) => trace.route.id === 'title-example')!;
  if (verify) {
    const programDirectory = await mkdtemp(join(tmpdir(), 'romstudio-nebulus-program-'));
    try {
      await writeFile(join(programDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
      const path = join(programDirectory, 'program.js');
      await writeStaticProgram(program, programDirectory);
      for (const trace of traces) {
        options.onProgress?.(`Checking exported Nebulus: ${trace.route.id}`);
        const replay = await analyseInProcess<NebulusAnalysisJob, NebulusAnalysisResult>(worker, {
          checkpoint: trace.launch,
          id: trace.route.id,
          frames: trace.route.frames,
          inputs: trace.data.inputs,
          capture: trace.capture,
          program: pathToFileURL(path).href,
        });
        if (
          trace.audio &&
          (!replay.audio ||
            sha256(
              new Uint8Array(replay.audio.buffer, replay.audio.byteOffset, replay.audio.byteLength),
            ) !==
              sha256(
                new Uint8Array(trace.audio.buffer, trace.audio.byteOffset, trace.audio.byteLength),
              ))
        ) {
          throw new Diagnostic('NEBULUS_AUDIO', `SID sample replay differs on ${trace.route.id}.`);
        }
        checks.push({
          name: `${trace.route.id}-static-replay`,
          passed: JSON.stringify(replay.fingerprint) === JSON.stringify(trace.fingerprint),
        });
      }
    } finally {
      await rm(programDirectory, { recursive: true, force: true });
    }
    const music = traces.find((trace) => trace.route.id === 'title-music')!;
    const entered = traces.find((trace) => trace.route.id === 'title-start')!;
    checks.push({
      name: 'title-waits-for-fire',
      passed: music.data.waitingToStart && music.data.logicTicks === 0,
    });
    checks.push({
      name: 'title-music-audible',
      passed: !!music.audio?.some((sample) => Math.abs(sample) > 0.001),
    });
    // Check entry before the longer example can lose its lives and return to
    // the title screen. An example's final menu flag cannot prove start failed.
    checks.push({
      name: 'fire-starts-original-game',
      passed: !entered.data.waitingToStart && entered.data.logicTicks > 0,
    });
    checks.push({
      name: 'original-movement',
      passed: traces.some((trace) => trace.bounds.maxRotation > trace.bounds.minRotation),
    });
    checks.push({
      name: 'original-death-and-respawn',
      passed: traces.some((trace) => trace.bounds.minLives < 3),
    });
    checks.push({
      name: 'static-code',
      passed: !/\b(?:eval|new Function)\s*\(/.test(program.javascript),
    });
    checks.push({
      name: 'sid-audio-replay',
      passed: !!example.audio?.some((sample) => Math.abs(sample) > 0.001),
    });
  }
  await writeFile(
    join(directory, 'analysis/verification-checks.json'),
    JSON.stringify(checks, null, 2),
  );
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('NEBULUS_PARITY', JSON.stringify(checks));
  }
  options.onProgress?.('Packaging Nebulus with the shared browser shell');
  const manifest = await packageWeb({
    directory,
    system: c64BrowserPackage,
    titleId: 'nebulus',
    checkpoint: start.menuCheckpoint,
    program,
    inputs: example.data.inputs,
    pixels: example.data.pixels!,
    titleModules: ['games/c64/nebulus/player.js', 'games/c64/nebulus/web/title.js'],
    learning: [
      {
        source: join(repositoryRoot, 'src/games/c64/nebulus/player.ts'),
        relative: 'learn/nebulus-player.ts',
      },
      {
        source: join(repositoryRoot, 'src/games/c64/nebulus/docs/GAMEPLAY.md'),
        relative: 'learn/NEBULUS-GAMEPLAY.md',
      },
    ],
    manifest: {
      buildId: start.boot.report.bootId,
      title: 'Nebulus — Tower Toppler',
      build: {
        status: 'release-ready',
        artifact: 'static-first-tower-browser-slice',
        playable: true,
        towers: [1],
      },
      verification: {
        referenceReplay: verify ? 'passed' : 'not-run',
        hardwareParity: 'unverified',
        checks,
        hashes: example.fingerprint,
        observations: {
          stats: example.data.stats,
          routes: traces.map((trace) => ({
            id: trace.route.id,
            frames: trace.route.frames,
            bounds: trace.bounds,
          })),
        },
      },
      backend: {
        kind: 'static-source-address-functions',
        shapes: program.shapes.length,
        exactByteVariants: traces.reduce((sum, trace) => sum + trace.trace.variants.length, 0),
        dynamicCompilerInBrowser: false,
      },
      staticCoverage: {
        kind: 'known-memory-envelope',
        start: 0x0200,
        end: 0x10000,
        shapes: program.shapes.length,
        classifiedControlFlowShapes: controlFlow.instructions.length,
        unresolved: controlFlow.unresolved,
      },
      launch: {
        checkpoint: 'title-screen',
        start: 'space-or-fire',
        originalBootReplayedDuringBuild: true,
        timing: 'pal-6569',
        controls: 'c64-joystick-port-2',
        screenTailFixture: start.launchFixture,
      },
      example: {
        controlFrames: example.route.frames,
        inputs: example.data.inputs.length,
        completion: false,
      },
      audio: {
        kind: 'approximate-sid',
        clock: 'pal',
        sampleReplay: 'passed',
        samples: example.audio!.length,
        speed: '1x-only',
        hardwareParity: 'unverified',
      },
      limitations: [
        'First-tower input coverage is bounded. Unrecovered source/opcode shapes stop explicitly. Tower completion and the rest of the title are unverified.',
        'The recorded example exercises controls and does not claim a completed tower.',
        'Startup workspace and screen-tail fixtures are declared. First-tower captures are tested with alternate screen-tail bytes.',
        'SID sound is approximate: analogue filter response, combined waveforms, envelope quirks and the checkpoint audio phase are unverified. CPU DMA stalls, exact video timing and hardware parity remain unverified.',
      ],
      media: { sha256: start.boot.report.identity.media },
      seedIdentity: sha256(JSON.stringify(checkpoint.cpu)),
    },
  });
  return { outputDirectory: directory, manifest };
}
