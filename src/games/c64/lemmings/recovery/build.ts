import { c64BrowserPackage } from '../../../../systems/c64/package.js';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { runLevelToFirstSpawn } from './level.js';
import { repositoryRoot, gameBuildDirectory } from '../../../../paths.js';
import { recover } from '../../../../transpiler/recover.js';
import { captureC64, type C64Checkpoint } from '../../../../systems/c64/snapshot.js';
import { LemmingsPlayer, levelResult, replayControls } from '../player.js';
import { firstLevelControls, cursorCoverageControls, CURSOR_COVERAGE_FRAMES } from './controls.js';
import { replayToControls } from '../../../../analysis/c64.js';
import {
  emitRecoveredProgram,
  importStaticProgram,
  knownMemoryInstructions,
  recoverStaticBranches,
} from '../../../../transpiler/program.js';
import { packageWeb } from '../../../../build/web-package.js';
import type { StartupOptions } from '../../../../startup.js';

export const defaultWebDirectory = gameBuildDirectory('c64/lemmings');

function recoverCursorCoverage(checkpoint: C64Checkpoint, selectDigger: boolean) {
  const player = new LemmingsPlayer(
    checkpoint,
    () => {},
    cursorCoverageControls(selectDigger),
    false,
  );
  const bounds = { minX: 255, maxX: 0, minY: 255, maxY: 0 };
  const trace = recover(player.machine, {
    stopAt: 0xffff,
    stopWhen: () => player.controlFrames >= CURSOR_COVERAGE_FRAMES,
    maxInstructions: 10000000,
    maxVariants: 50000,
    maxBoundaryOperations: 150000,
    onFetch: (instruction) => player.bus.observe(instruction),
    onBoundary: () => {
      // Sample completed cursor updates at the next input entry. Intermediate
      // ADC/SBC results can exceed a limit before the clamp executes.
      if (player.machine.pc === 0x16d3) {
        const x = player.bus.bytes[0xb6]!,
          y = player.bus.bytes[0xb8]!;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
      return player.boundary();
    },
  });
  const id = selectDigger ? 'cursor-digger' : 'cursor-default';
  // $185D/$18B8 clamp horizontal movement; $180C/$17E8 clamp vertical
  // movement. Finishing an input trace alone does not prove these edges ran.
  const reachedLimits =
    bounds.minX === 4 && bounds.maxX === 83 && bounds.minY === 17 && bounds.maxY === 167;
  if (trace.stop !== 'checkpoint' || !reachedLimits) {
    throw new Diagnostic(
      'WEB_COVERAGE',
      JSON.stringify({ id, stop: trace.stop, gap: trace.gap, bounds }),
    );
  }
  return {
    id,
    player,
    trace,
    bounds,
    reachedLimits,
    state: sha256(JSON.stringify(captureC64(player.bus, player.machine))),
  };
}

/** Build and verify a local static export. The reference recovers exact byte
 * variants dynamically; the delivered module is emitted once from their
 * reviewed address/opcode shapes and never includes the recovery compiler. */
export async function buildWeb(
  options: StartupOptions & {
    onProgress?: (message: string) => void;
    /** Replay the exported static code against original execution (default
     * true). `false` packages only: the recovery that produces the package
     * still runs, but static-vs-original replays and parity checks are skipped
     * and the manifest records the reference replay as 'not-run'. */
    verify?: boolean;
  } = {},
) {
  const verify = options.verify ?? true;
  const directory = resolve(options.outputDirectory ?? defaultWebDirectory);
  options.onProgress?.('Booting the original disks to the first level');
  const runtime = await runLevelToFirstSpawn({
    ...options,
    level: 1,
    outputDirectory: join(directory, 'analysis'),
  });
  if (runtime.result.stop !== 'checkpoint') {
    throw new Diagnostic('WEB_START', 'Browser export requires a verified first spawn.');
  }
  const checkpoint = captureC64(runtime.bus, runtime.machine),
    controller = firstLevelControls();
  options.onProgress?.('Recording the original first-level completion');
  const reference = new LemmingsPlayer(
    checkpoint,
    () => {},
    (frame, player) => controller(frame, player.bus),
  );
  reference.enableAudio(44100);
  const trace = recover(reference.machine, {
    stopAt: 0xffff,
    stopWhen: (machine) => {
      reference.outcome = levelResult(machine);
      return !!reference.outcome;
    },
    maxInstructions: 40000000,
    maxVariants: 50000,
    maxBoundaryOperations: 300000,
    onFetch: (instruction) => reference.bus.observe(instruction),
    onBoundary: () => reference.boundary(),
  });
  if (trace.stop !== 'checkpoint' || !reference.outcome?.won) {
    throw new Diagnostic(
      'WEB_REFERENCE',
      `Reference did not finish: ${JSON.stringify(trace.gap ?? reference.outcome)}.`,
    );
  }
  const referenceState = reference.machine.snapshot(),
    referenceDevices = captureC64(reference.bus, reference.machine);
  const referenceHashes = {
    memory: sha256(reference.bus.bytes),
    known: sha256(reference.bus.known),
    display: sha256(reference.display.pixels),
  };
  const referenceAudio = reference.takeAudio();
  options.onProgress?.('Recovering cursor and scroll paths');
  const cursorCoverage = [
    recoverCursorCoverage(checkpoint, false),
    recoverCursorCoverage(checkpoint, true),
  ];
  const traces = [trace, ...cursorCoverage.map((coverage) => coverage.trace)];
  const controlFlow = recoverStaticBranches(
    checkpoint,
    traces.flatMap((trace) => trace.variants.map((variant) => variant.address)),
    { start: 0x0800, end: 0x4000 },
  );
  const envelope = knownMemoryInstructions(checkpoint, { start: 0x0200, end: 0x10000 });
  const emitted = emitRecoveredProgram(traces, {}, [...controlFlow.instructions, ...envelope]);
  options.onProgress?.(
    `Emitting ${emitted.shapes.length} guarded instruction shapes (${emitted.javascript.length} bytes)`,
  );
  const staticCode = {
    name: 'static-code',
    passed: !/\b(?:eval|new Function)\s*\(/.test(emitted.javascript),
  };
  const nativeFinished = {
    name: 'native-level-finished',
    passed: trace.stop === 'checkpoint' && !!reference.outcome?.won,
  };
  // Verification only: the imported static module and its replays feed checks,
  // never package contents.
  async function verifyStaticReplay() {
    const generated = await importStaticProgram(emitted);
    options.onProgress?.('Checking exported cursor movement at all four limits');
    const cursorChecks = cursorCoverage.map((coverage) => {
      const cursorReplay = new LemmingsPlayer(
        checkpoint,
        generated.step,
        replayControls(coverage.player.inputs),
        false,
      );
      replayToControls(cursorReplay, CURSOR_COVERAGE_FRAMES, 10000000);
      return {
        name: `${coverage.id}-replay`,
        passed:
          coverage.reachedLimits &&
          sha256(JSON.stringify(captureC64(cursorReplay.bus, cursorReplay.machine))) ===
            coverage.state &&
          JSON.stringify(cursorReplay.inputs) === JSON.stringify(coverage.player.inputs),
      };
    });
    const replay = new LemmingsPlayer(checkpoint, generated.step, replayControls(reference.inputs));
    replay.enableAudio(44100);
    options.onProgress?.('Checking static replay against original execution');
    for (let frame = 0; frame < 6000 && !replay.outcome && !replay.gap; frame++) {
      replay.advanceFrame();
    }
    const replayHashes = {
      memory: sha256(replay.bus.bytes),
      known: sha256(replay.bus.known),
      display: sha256(replay.display.pixels),
    };
    const replayAudio = replay.takeAudio();
    const checks = [
      nativeFinished,
      { name: 'static-level-finished', passed: !!replay.outcome?.won && !replay.gap },
      {
        name: 'cpu-state',
        passed: JSON.stringify(replay.machine.snapshot()) === JSON.stringify(referenceState),
      },
      {
        name: 'memory-knownness-and-raster',
        passed: JSON.stringify(replayHashes) === JSON.stringify(referenceHashes),
      },
      {
        name: 'device-state',
        passed:
          JSON.stringify(captureC64(replay.bus, replay.machine)) ===
          JSON.stringify(referenceDevices),
      },
      {
        name: 'result',
        passed: JSON.stringify(replay.outcome) === JSON.stringify(reference.outcome),
      },
      {
        name: 'recorded-inputs',
        passed: JSON.stringify(replay.inputs) === JSON.stringify(reference.inputs),
      },
      {
        name: 'sid-audio-replay',
        passed:
          sha256(new Uint8Array(replayAudio.buffer)) ===
            sha256(new Uint8Array(referenceAudio.buffer)) &&
          referenceAudio.some((sample) => Math.abs(sample) > 0.001),
      },
      ...cursorChecks,
      staticCode,
    ];
    return { cursorChecks, replay, replayHashes, checks };
  }
  const parity = verify ? await verifyStaticReplay() : undefined;
  const cursorChecks = parity?.cursorChecks ?? [];
  const replay = parity?.replay;
  const replayHashes = parity?.replayHashes;
  const checks = parity ? parity.checks : [nativeFinished, staticCode];
  const passed = checks.every((check) => check.passed);
  if (!passed) {
    throw new Diagnostic(
      'WEB_PARITY',
      JSON.stringify({
        checks,
        gap: replay?.gap,
        referenceState,
        replayState: replay?.machine.snapshot(),
      }),
    );
  }
  options.onProgress?.('Packaging the local browser slice');
  const metadata = {
    buildId: runtime.trial.manifest.buildId,
    title: 'Lemmings — Just dig!',
    build: {
      status: 'release-ready',
      artifact: 'static-first-level-browser-slice',
      playable: true,
      levels: [1],
    },
    verification: {
      referenceReplay: verify ? 'passed' : 'not-run',
      hardwareParity: 'unverified',
      checks,
      result: replay?.outcome,
      hashes: replayHashes,
    },
    backend: {
      kind: 'static-source-address-functions',
      mutableOperands: 'reviewed instruction fields',
      shapes: emitted.shapes.length,
      exactByteVariants:
        trace.variants.length +
        cursorCoverage.reduce((sum, coverage) => sum + coverage.trace.variants.length, 0),
      dynamicCompilerInBrowser: false,
    },
    staticCoverage: {
      kind: 'known-memory-envelope',
      start: 0x0200,
      end: 0x10000,
      shapes: emitted.shapes.length,
      classifiedControlFlowShapes: controlFlow.instructions.length,
      unresolved: controlFlow.unresolved,
    },
    launch: {
      checkpoint: 'first-lemming-spawn',
      originalBootReplayedDuringBuild: true,
      controls: 'c64-joystick-port-2',
      timing: 'pal-6569',
    },
    example: {
      inputs: reference.inputs.length,
      controlFrames: reference.controlFrames,
      logicTicks: reference.logicTicks,
      includesNuke: true,
      completion: true,
    },
    audio: {
      kind: 'approximate-sid',
      clock: 'pal',
      sampleReplay: verify ? 'passed' : 'not-run',
      samples: referenceAudio.length,
      speed: '1x-only',
      hardwareParity: 'unverified',
    },
    cursorCoverage: cursorCoverage.map((coverage) => ({
      id: coverage.id,
      controlFrames: CURSOR_COVERAGE_FRAMES,
      bounds: coverage.bounds,
      reachedAllLimits: coverage.reachedLimits,
      staticReplay: !verify
        ? 'not-run'
        : cursorChecks.find((check) => check.name === `${coverage.id}-replay`)!.passed
          ? 'passed'
          : 'failed',
    })),
    limitations: [
      'Only the first level and recovered source/opcode shapes are exported. Uncovered paths stop explicitly; this is a partial title build.',
      'Mutable instruction operands are read as data under guarded, recovered instruction shapes. This reviewed lowering differs from exact-byte recovery guards.',
      'The raster capture retains active sprite rows and badline character/colour latches. Fetch groups and whole-line output are sampled at instruction boundaries; CPU DMA stalls, per-column fetches, sub-instruction timing and analogue PAL colour remain unverified.',
      'SID sound is approximate: analogue filter response, combined waveforms, envelope quirks and checkpoint audio phase are unverified. Save/resume and level progression are outside this slice.',
      'The launch workspaces and previous-header fixtures remain declared in the level chapter. Internal replay parity is not independent hardware evidence.',
    ],
  };
  const manifest = await packageWeb({
    directory,
    system: c64BrowserPackage,
    titleId: 'lemmings',
    manifest: metadata,
    checkpoint,
    program: emitted,
    inputs: reference.inputs.map((input) => ({
      frame: input.frame,
      joystick: input.joystick,
      keys: [...(input.key8 ? [27] : []), ...(input.deleteKey ? [0] : [])],
    })),
    pixels: reference.display.pixels,
    titleModules: [
      'games/c64/lemmings/player.js',
      'games/c64/lemmings/web/title.js',
      'games/c64/lemmings/code/level-data.js',
      'games/c64/lemmings/code/digger.js',
    ],
    learning: [
      {
        source: join(repositoryRoot, 'src/games/c64/lemmings/code/digger.ts'),
        relative: 'learn/digger.ts',
      },
      {
        source: join(repositoryRoot, 'src/games/c64/lemmings/docs/DIGGER.md'),
        relative: 'learn/LEMMINGS-DIGGER.md',
      },
    ],
  });
  return { outputDirectory: directory, manifest };
}
