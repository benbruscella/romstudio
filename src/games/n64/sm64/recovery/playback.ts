import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { gameBuildDirectory } from '../../../../paths.js';
import {
  sourceSnapshot,
  assertSourceSnapshot,
  type SourceSnapshot,
} from '../../../../analysis/source-snapshot.js';
import { N64System } from '../../../../systems/n64/system.js';
import { compactN64Checkpoint, type N64Checkpoint } from '../../../../systems/n64/checkpoint.js';
import { renderN64ColorImage } from '../../../../systems/n64/render.js';
import { N64Recovery } from '../../../../transpiler/n64-recovery.js';
import type { Vr4300Machine, Vr4300Program } from '../../../../runtime/vr4300.js';
import type { RspMachine, RspProgram } from '../../../../runtime/rsp.js';
import { importStaticProgram } from '../../../../transpiler/program.js';
import { liftVr4300Pages, type Vr4300Instruction } from '../../../../transpiler/vr4300.js';
import { liftRsp, type RspInstruction } from '../../../../transpiler/rsp.js';
import { encodePng } from '../../../../png.js';
import { bootSm64Graphics } from './graphics.js';
import { loadSm64Cartridge } from './cartridge.js';
import type { StartupOptions } from '../../../../startup.js';

export interface Sm64PlaybackOptions extends StartupOptions {
  onProgress?: (message: string) => void;
  /** Explicit analysis fixture, never a relabelled current-source cache. The
   * new run records its earlier origin and checks current execution afresh. */
  titleFixtureFingerprint?: string;
  /** Replay current static code against an explicitly checked earlier original
   * endpoint/PCM stream. This does not rerun original recovery under new source. */
  replayFixtureFingerprint?: string;
  /** Build: capture the original run for packaging but skip the static
   * replay comparison, which belongs to verification (`verify-game`). */
  skipReplay?: boolean;
}

/** Passive build-time observer. Hash exact stereo values and source rates,
 * independently of browser resampling or output scheduling. */
function observePcm(system: N64System) {
  const hash = createHash('sha256'),
    sample = Buffer.alloc(24);
  let samples = 0;
  system.memory.audio.output = (left, right, rate) => {
    sample.writeDoubleLE(left, 0);
    sample.writeDoubleLE(right, 8);
    sample.writeDoubleLE(rate, 16);
    hash.update(sample);
    samples++;
  };
  return () => ({ samples, sha256: hash.digest('hex') });
}

/** This sequence drives the original EU menus; it never writes game state. */
export function sm64OpeningControls(system: N64System): void {
  let startPoll = 0,
    returnPoll = 0,
    filePoll = 0;
  const pad = system.memory.serial;
  pad.onControllerRead = () => {
    pad.buttons = pad.stickX = pad.stickY = 0;
    const sync = system.memory.display.fullSyncs;
    if (sync >= 206) {
      filePoll++;
      pad.stickX = filePoll <= 10 ? -80 : 0;
      pad.stickY = filePoll <= 12 ? 80 : 0;
      pad.buttons = filePoll === 15 ? 0x8000 : 0;
    } else if (sync >= 174) {
      returnPoll++;
      pad.stickX = returnPoll <= 10 ? 80 : 0;
      pad.stickY = returnPoll <= 12 ? -80 : 0;
      pad.buttons = returnPoll === 15 ? 0x8000 : 0;
    } else if (sync >= 131) {
      startPoll++;
      pad.buttons = startPoll <= 2 ? 0x1000 : 0;
    }
  };
}

function includeCpuEnvelope(recovery: N64Recovery, system: N64System): void {
  // Pinned EU layout: vectors, menu/Goddard load, main load and engine.
  // These ranges include data and padding. Unvisited words are a coverage
  // envelope, explicitly separate from observed assembly in Learn.
  for (const [start, end] of [
    [0x80000000, 0x80000400],
    [0x8016f000, 0x801b8d80],
    [0x80241800, 0x80307e50],
    [0x8036ff00, 0x80386a10],
  ] as const) {
    recovery.includeCpuMemory(system.memory.ram.bytes, start, end);
  }
}

function run(
  system: N64System,
  step: (cpu: Vr4300Machine) => void,
  sync: number,
  progress?: (message: string) => void,
  recovery?: N64Recovery,
  idleAddresses?: ReadonlySet<number>,
): void {
  let nextProgress = Date.now() + 10000,
    transfer = system.memory.signal.transfers.length;
  while (system.memory.display.fullSyncs < sync && system.ticks < 2200000000) {
    if ((idleAddresses && !idleAddresses.has(system.cpu.pc)) || !system.advanceIdle()) {
      system.step(step);
    }
    const transfers = system.memory.signal.transfers;
    if (recovery && transfers.length !== transfer) {
      if (transfers.slice(transfer).some((t) => !t.write && t.memory >= 4096)) {
        recovery.includeRspMemory(system.memory.signal.memory.subarray(4096));
      }
      transfer = transfers.length;
    }
    if (Date.now() >= nextProgress) {
      progress?.(
        `${system.memory.display.fullSyncs}/${sync} completed graphics tasks; ${system.ticks.toLocaleString()} functional ticks.`,
      );
      nextProgress = Date.now() + 10000;
    }
  }
  if (system.memory.display.fullSyncs !== sync) {
    throw new Diagnostic(
      'SM64_PLAYBACK_BUDGET',
      'Original menu route exceeded its functional tick budget.',
    );
  }
}

export async function prepareSm64Playback(options: Sm64PlaybackOptions = {}) {
  if (options.titleFixtureFingerprint && options.replayFixtureFingerprint) {
    throw new Diagnostic(
      'SM64_FIXTURE_MODE',
      'Select a title fixture or an original replay reference, not both.',
    );
  }
  const directory = join(gameBuildDirectory('n64/sm64'), 'analysis/playback');
  await mkdir(directory, { recursive: true });
  const media = await loadSm64Cartridge(options);
  let fixture: { record: PlaybackRecord; files: Record<string, Uint8Array> } | undefined;
  if (options.titleFixtureFingerprint || options.replayFixtureFingerprint) {
    const id = (options.titleFixtureFingerprint ?? options.replayFixtureFingerprint)!;
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Diagnostic('SM64_TITLE_FIXTURE', 'Expected a captured-title source fingerprint.');
    }
    const root = join(directory, id);
    const record = JSON.parse(await readFile(join(root, 'record.json'), 'utf8')) as PlaybackRecord;
    if (
      record.fingerprint !== id ||
      record.verification.referenceReplay !== 'passed' ||
      record.verification.checks.some((check) => !check.passed)
    ) {
      throw new Diagnostic(
        'SM64_TITLE_FIXTURE',
        'The earlier capture has no successful recorded replay.',
      );
    }
    const files: Record<string, Uint8Array> = {};
    for (const [name, hash] of Object.entries(record.files)) {
      if (!/^[a-z][a-z0-9.-]*$/.test(name)) {
        throw new Diagnostic('SM64_TITLE_FIXTURE', 'Invalid captured file name.');
      }
      const bytes = await readFile(join(root, name));
      if (sha256(bytes) !== hash) {
        throw new Diagnostic('SM64_TITLE_FIXTURE', `Changed earlier capture: ${name}.`);
      }
      files[name] = bytes;
    }
    if (record.mediaSha256 && record.mediaSha256 !== media.identity.canonicalSha256) {
      throw new Diagnostic(
        'SM64_TITLE_FIXTURE',
        'The captured cartridge differs from this recipe.',
      );
    }
    if (
      !files['title.json'] ||
      files['rdram.bin']?.length !== 4194304 ||
      files['signal.bin']?.length !== 8192
    ) {
      throw new Diagnostic('SM64_TITLE_FIXTURE', 'The captured title memories are incomplete.');
    }
    fixture = { record, files };
  }
  const origin = fixture
    ? {
        kind: options.replayFixtureFingerprint
          ? 'earlier-verified-original-endpoint'
          : 'earlier-captured-title-fixture',
        sourceFingerprint: fixture.record.fingerprint,
        files: Object.fromEntries(
          (options.replayFixtureFingerprint
            ? Object.keys(fixture.record.files)
            : ['title.json', 'rdram.bin', 'signal.bin']
          ).map((name) => [name, fixture!.record.files[name]]),
        ),
        earlierStartup: 'not reverified under the current model',
      }
    : { kind: 'current-original-startup', consoleReset: 'unverified' };
  const modelSources = await sourceSnapshot([
    'src/games/n64/sm64/recovery/playback.ts',
    'src/games/n64/sm64/recovery/build.ts',
    'src/systems/n64/web/worker.ts',
    'src/systems/n64/web/app.ts',
  ]);
  const fingerprint = sha256(JSON.stringify([media.identity, origin, modelSources]));
  // Capture cache is content-addressed to the exact media, fixture and modeled
  // machine semantics. No manual dist/work scratch file is an input.
  const cache = join(directory, fingerprint);
  try {
    const record = JSON.parse(await readFile(join(cache, 'record.json'), 'utf8')) as PlaybackRecord;
    if (record.verification.referenceReplay === 'not-run' && !options.skipReplay) {
      // Recovery-only capture: verification reruns recovery and the replay.
      throw Object.assign(new Error('Recovery-only capture.'), { code: 'ENOENT' });
    }
    if (
      record.fingerprint !== fingerprint ||
      (record.verification.referenceReplay !== 'passed' &&
        record.verification.referenceReplay !== 'not-run') ||
      record.verification.checks.some((check) => !check.passed) ||
      JSON.stringify(record.sourceSnapshot) !== JSON.stringify(modelSources)
    ) {
      throw new Diagnostic(
        'SM64_PLAYBACK_RECORD',
        'Cached verification does not match this model snapshot.',
      );
    }
    const files = Object.fromEntries(
      await Promise.all(
        Object.entries(record.files).map(async ([name, hash]) => {
          if (!/^[a-z][a-z0-9.-]*$/.test(name)) {
            throw new Diagnostic('SM64_PLAYBACK_HASH', 'Invalid cached file name.');
          }
          const bytes = await readFile(join(cache, name));
          if (sha256(bytes) !== hash) {
            throw new Diagnostic('SM64_PLAYBACK_HASH', `Changed cached input ${name}.`);
          }
          return [name, bytes];
        }),
      ),
    );
    return { directory: cache, record, files, media };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (options.replayFixtureFingerprint && fixture) {
    const files = fixture.files;
    if (
      !fixture.record.verification.checks.some(
        (c) => c.name === 'original-vs-static-stereo-pcm' && c.passed,
      ) ||
      !files['end.json'] ||
      files['end-rdram.bin']?.length !== 4194304 ||
      files['end-signal.bin']?.length !== 8192 ||
      !files['pcm.json']
    ) {
      throw new Diagnostic(
        'SM64_REPLAY_REFERENCE',
        'The reference needs a checked original endpoint and stereo PCM stream. Run original/static recovery first.',
      );
    }
    const title = JSON.parse(Buffer.from(files['title.json']!).toString()) as N64Checkpoint,
      expected = JSON.parse(Buffer.from(files['end.json']).toString()) as N64Checkpoint,
      pcm = JSON.parse(Buffer.from(files['pcm.json']).toString()) as {
        encoding: string;
        original: { samples: number; sha256: string };
      };
    if (
      title.devices.display.fullSyncs !== 131 ||
      expected.devices.display.fullSyncs !== 284 ||
      pcm.encoding !== 'float64le-left-right-source-rate' ||
      !Number.isSafeInteger(pcm.original.samples) ||
      pcm.original.samples < 1 ||
      !/^[a-f0-9]{64}$/.test(pcm.original.sha256)
    ) {
      throw new Diagnostic(
        'SM64_REPLAY_REFERENCE',
        'The original reference boundary or PCM encoding is invalid.',
      );
    }
    options.onProgress?.(
      'Comparing current static execution with the explicitly selected earlier original endpoint and PCM stream…',
    );
    const cpu = (await importStaticProgram<Vr4300Machine>(
        liftVr4300Pages(
          JSON.parse(Buffer.from(files['cpu.json']!).toString()) as Vr4300Instruction[],
        ),
      )) as Vr4300Program,
      rsp = (await importStaticProgram<RspMachine>(
        liftRsp(JSON.parse(Buffer.from(files['rsp.json']!).toString()) as RspInstruction[]),
      )) as RspProgram,
      replay = new N64System(media.rom, 0, 512, true);
    replay.memory.ram.bytes.set(files['rdram.bin']!);
    replay.memory.signal.memory.set(files['signal.bin']!);
    replay.enableRsp(rsp.step, rsp.prepareLinear, rsp.runLocal);
    replay.restore(title);
    sm64OpeningControls(replay);
    const finishPcm = observePcm(replay);
    run(replay, cpu.step, 284, options.onProgress, undefined, cpu.idleAddresses);
    const actualPcm = finishPcm();
    const checks = [
      {
        name: 'captured-original-vs-static-processors-devices-and-clock',
        passed: JSON.stringify(compactN64Checkpoint(replay)) === JSON.stringify(expected),
      },
      {
        name: 'captured-original-vs-static-rdram',
        passed: sha256(replay.memory.ram.bytes) === fixture.record.files['end-rdram.bin'],
      },
      {
        name: 'captured-original-vs-static-sp-memory',
        passed: sha256(replay.memory.signal.memory) === fixture.record.files['end-signal.bin'],
      },
      {
        name: 'captured-original-controller-traffic',
        passed: replay.memory.serial.controllerReads > title.devices.serial.controllerReads + 100,
      },
      {
        name: 'captured-original-vs-static-stereo-pcm',
        passed:
          actualPcm.samples === pcm.original.samples && actualPcm.sha256 === pcm.original.sha256,
      },
    ];
    if (checks.some((c) => !c.passed)) {
      throw new Diagnostic('SM64_REFERENCE_PARITY', JSON.stringify(checks));
    }
    await assertSourceSnapshot(modelSources);
    const record: PlaybackRecord = {
      fingerprint,
      sourceSnapshot: modelSources,
      origin,
      mediaSha256: media.identity.canonicalSha256,
      verification: {
        referenceReplay: 'passed',
        hardwareParity: 'unverified',
        gameplay: 'unverified',
        pixelPrecision: 'functional-approximation',
        checks,
      },
      title: fixture.record.title,
      end: fixture.record.end,
      files: fixture.record.files,
    };
    return persistPlayback(cache, record, files, media);
  }
  const recovery = new N64Recovery();
  let native: N64System;
  if (fixture) {
    options.onProgress?.(
      'Restoring the explicitly selected earlier title fixture; checking current original/static execution from that state…',
    );
    native = new N64System(media.rom, 0, 512);
    native.memory.ram.bytes.set(fixture.files['rdram.bin']!);
    native.memory.signal.memory.set(fixture.files['signal.bin']!);
    native.restore(
      JSON.parse(Buffer.from(fixture.files['title.json']!).toString()) as N64Checkpoint,
    );
    if (native.memory.display.fullSyncs !== 131) {
      throw new Diagnostic('SM64_TITLE_FIXTURE', 'Expected the original title at FullSync 131.');
    }
  } else {
    options.onProgress?.(
      'Verifying startup and the first textured task before capturing the original title…',
    );
    native = (await bootSm64Graphics({ ...options, stage: 'frame' })).checkpoint;
  }
  native.memory.display.beforeDraw = undefined;
  native.enableRsp(recovery.stepRsp);
  recovery.includeRspMemory(native.memory.signal.memory.subarray(4096));
  run(native, recovery.stepCpu, 131, options.onProgress, recovery, recovery.idleAddresses);
  includeCpuEnvelope(recovery, native);
  const title = compactN64Checkpoint(native),
    ram = native.memory.ram.bytes.slice(),
    signal = native.memory.signal.memory.slice();
  const titlePixels = renderN64ColorImage(ram, native.memory.display.colorImage, 240);
  const originalPcm = observePcm(native);
  sm64OpeningControls(native);
  options.onProgress?.('Following original Start, EU settings Return and empty-file selection…');
  run(native, recovery.stepCpu, 284, options.onProgress, recovery, recovery.idleAddresses);
  const programs = recovery.emit();
  options.onProgress?.(
    `Replaying original menus using ${programs.cpu.instructions.length} static CPU and ${programs.rsp.instructions.length} RSP instruction variants…`,
  );
  const expectedPcm = originalPcm();
  let actualPcm: typeof expectedPcm | undefined;
  let checks: { name: string; passed: boolean }[] = [];
  if (options.skipReplay) {
    options.onProgress?.(
      'Saved the original capture; the static replay comparison runs in verification, not build.',
    );
  } else {
    const cpu = (await importStaticProgram<Vr4300Machine>(programs.cpu)) as Vr4300Program,
      rsp = (await importStaticProgram<RspMachine>(programs.rsp)) as RspProgram;
    const replay = new N64System(media.rom, 0, 512, true);
    replay.memory.ram.bytes.set(ram);
    replay.memory.signal.memory.set(signal);
    replay.enableRsp(rsp.step, rsp.prepareLinear, rsp.runLocal);
    replay.restore(title);
    const staticPcm = observePcm(replay);
    sm64OpeningControls(replay);
    run(replay, cpu.step, 284, options.onProgress, undefined, cpu.idleAddresses);
    actualPcm = staticPcm();
    checks = [
      {
        name: 'original-vs-static-processors-devices-and-clock',
        passed:
          JSON.stringify(compactN64Checkpoint(native)) ===
          JSON.stringify(compactN64Checkpoint(replay)),
      },
      {
        name: 'original-vs-static-rdram',
        passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
      },
      {
        name: 'original-vs-static-sp-memory',
        passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
      },
      {
        name: 'original-controller-traffic',
        passed: native.memory.serial.controllerReads > title.devices.serial.controllerReads + 100,
      },
      {
        name: 'original-vs-static-stereo-pcm',
        passed:
          expectedPcm.samples > 0 && JSON.stringify(expectedPcm) === JSON.stringify(actualPcm),
      },
    ];
    if (checks.some((check) => !check.passed)) {
      throw new Diagnostic('SM64_PLAYBACK_PARITY', JSON.stringify(checks));
    }
  }
  await assertSourceSnapshot(modelSources);
  await mkdir(cache, { recursive: true });
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, bytes: Uint8Array | string) => {
    files[name] = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  };
  put('title.json', JSON.stringify(title));
  put('rdram.bin', ram);
  put('signal.bin', signal);
  // Keep a checked original endpoint for later performance/debug fixtures.
  // The browser still starts at the original title unless explicitly testing
  // a different declared capture; these files remain analysis inputs.
  put('end.json', JSON.stringify(compactN64Checkpoint(native)));
  put('end-rdram.bin', native.memory.ram.bytes);
  put('end-signal.bin', native.memory.signal.memory);
  put(
    'pcm.json',
    JSON.stringify({
      encoding: 'float64le-left-right-source-rate',
      original: expectedPcm,
      static: actualPcm ?? null,
    }),
  );
  put('title.png', encodePng(320, 240, titlePixels));
  put('cpu.json', JSON.stringify(programs.cpu.instructions));
  put('rsp.json', JSON.stringify(programs.rsp.instructions));
  put('cpu-observed.json', JSON.stringify(recovery.observations('cpu')));
  put('rsp-observed.json', JSON.stringify(recovery.observations('rsp')));
  put(
    'opening.png',
    encodePng(
      320,
      240,
      renderN64ColorImage(native.memory.ram.bytes, native.memory.display.colorImage, 240),
    ),
  );
  const record: PlaybackRecord = {
    fingerprint,
    sourceSnapshot: modelSources,
    origin,
    mediaSha256: media.identity.canonicalSha256,
    verification: {
      referenceReplay: options.skipReplay ? 'not-run' : 'passed',
      hardwareParity: 'unverified',
      gameplay: 'unverified',
      pixelPrecision: 'functional-approximation',
      checks,
    },
    title: { ticks: title.ticks, fullSyncs: 131 },
    end: { ticks: native.ticks, fullSyncs: 284 },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
  };
  return persistPlayback(cache, record, files, media);
}

const packagedFiles = [
  'title.json',
  'rdram.bin',
  'signal.bin',
  'title.png',
  'cpu.json',
  'rsp.json',
  'cpu-observed.json',
  'rsp-observed.json',
];

/** Build input: the passing capture verified for the current sources, or
 * otherwise the newest passing capture for this cartridge. Packaging reuses
 * it with the current code and never re-verifies; `current` says whether its
 * verification applies to the sources being packaged. */
export async function loadSm64Capture(options: StartupOptions = {}) {
  const directory = join(gameBuildDirectory('n64/sm64'), 'analysis/playback');
  const media = await loadSm64Cartridge(options);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [] as string[];
    }
    throw error;
  });
  const candidates: { root: string; record: PlaybackRecord; current: boolean; time: number }[] = [];
  for (const name of names.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
    const root = join(directory, name);
    let record: PlaybackRecord;
    try {
      record = JSON.parse(await readFile(join(root, 'record.json'), 'utf8')) as PlaybackRecord;
    } catch {
      continue;
    }
    const replay = record.verification.referenceReplay;
    if (
      (replay !== 'passed' && replay !== 'not-run') ||
      record.verification.checks.some((check) => !check.passed) ||
      (record.mediaSha256 && record.mediaSha256 !== media.identity.canonicalSha256) ||
      packagedFiles.some((file) => !record.files[file])
    ) {
      continue;
    }
    let current = false;
    if (record.sourceSnapshot) {
      try {
        await assertSourceSnapshot(record.sourceSnapshot);
        current = true;
      } catch {
        current = false;
      }
    }
    candidates.push({ root, record, current, time: (await stat(root)).mtimeMs });
  }
  // Prefer current sources, then a passed replay, then the newest capture.
  const passed = (record: PlaybackRecord) => record.verification.referenceReplay === 'passed';
  candidates.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(passed(b.record)) - Number(passed(a.record)) ||
      b.time - a.time,
  );
  const chosen = candidates[0];
  if (!chosen) {
    throw new Diagnostic(
      'SM64_CAPTURE',
      'No recovery capture for this cartridge yet. Run npm run cli -- verify-game n64/sm64 once.',
    );
  }
  const files: Record<string, Uint8Array> = {};
  for (const [name, hash] of Object.entries(chosen.record.files)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) {
      throw new Diagnostic('SM64_CAPTURE', 'Invalid captured file name.');
    }
    const bytes = await readFile(join(chosen.root, name));
    if (sha256(bytes) !== hash) {
      throw new Diagnostic('SM64_CAPTURE', `Changed captured file ${name}.`);
    }
    files[name] = bytes;
  }
  return {
    directory: chosen.root,
    record: chosen.record,
    files,
    media,
    // Verification applies only to a passed replay of these exact sources.
    current: chosen.current && passed(chosen.record),
  };
}

async function persistPlayback(
  directory: string,
  record: PlaybackRecord,
  files: Record<string, Uint8Array>,
  media: Awaited<ReturnType<typeof loadSm64Cartridge>>,
) {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, bytes]) => writeFile(join(directory, name), bytes)),
  );
  await writeFile(join(directory, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  return { directory, record, files, media };
}

export interface PlaybackRecord {
  fingerprint: string;
  sourceSnapshot?: SourceSnapshot;
  origin?: Record<string, unknown>;
  mediaSha256?: string;
  verification: {
    referenceReplay: string;
    hardwareParity: string;
    gameplay: string;
    pixelPrecision: string;
    checks: { name: string; passed: boolean }[];
  };
  title: { ticks: number; fullSyncs: number };
  end: { ticks: number; fullSyncs: number };
  files: Record<string, string>;
}
