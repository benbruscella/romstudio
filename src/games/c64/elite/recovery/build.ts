import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { bootElite } from './boot.js';
import { Diagnostic } from '../../../../core.js';
import { gameBuildDirectory, repositoryRoot } from '../../../../paths.js';
import {
  emitRecoveredProgram,
  recoverStaticBranches,
  writeStaticProgram,
  knownMemoryInstructions,
} from '../../../../transpiler/program.js';
import { analyseInProcess } from '../../../../analysis/process.js';
import { packageWeb } from '../../../../build/web-package.js';
import { c64BrowserPackage } from '../../../../systems/c64/package.js';
import type { EliteJob, EliteEvidence } from './analysis-worker.js';
import type { RecordedControls } from '../../../../systems/c64/input.js';
import type { StartupOptions } from '../../../../startup.js';

const input = (frame: number, keys: number[] = [], joystick = 255): RecordedControls => ({
  frame,
  keys,
  joystick,
});
const start = [
  input(1),
  input(40, [39]),
  input(70),
  input(400, [60]),
  input(430),
  input(1000, [4]),
  input(1030),
];
const routes = [
  // The rotating ship reaches an uncovered drawing instruction after poll
  // 608. The earlier 400-poll check stopped before ordinary title-screen use.
  { id: 'title-idle', frames: 5000, inputs: [input(1)] },
  {
    id: 'title-arrows',
    frames: 5000,
    inputs: [
      input(1),
      input(20, [], 254),
      input(600),
      input(700, [], 253),
      input(1300),
      input(1400, [], 251),
      input(2000),
      input(2100, [], 247),
      input(2700),
      input(2800, [], 246),
      input(3400),
      input(3500, [], 249),
      input(4100),
    ],
  },
  {
    id: 'example',
    frames: 2000,
    inputs: [
      ...start,
      input(1500, [], 247),
      input(1560),
      input(1600, [], 254),
      input(1660),
      input(1700, [60], 239),
      input(1740),
      input(1800, [5]),
      input(1830),
      input(1860, [6]),
      input(1890),
      input(1920, [3]),
      input(1950),
    ],
  },
  {
    id: 'flight-and-views',
    frames: 2000,
    inputs: [
      ...start,
      input(1500, [], 251),
      input(1560),
      input(1600, [], 253),
      input(1660),
      input(1700, [4]),
      input(1730),
      input(1760, [5]),
      input(1790),
      input(1820, [6]),
      input(1850),
      input(1880, [3]),
      input(1910),
    ],
  },
];
export async function buildEliteWeb(
  options: StartupOptions & { onProgress?: (message: string) => void } = {},
) {
  const directory = resolve(options.outputDirectory ?? gameBuildDirectory('c64/elite'));
  options.onProgress?.('Booting Elite and declining ten trainers');
  const boot = await bootElite({ ...options, outputDirectory: join(directory, 'analysis/boot') }),
    worker = new URL('./analysis-worker.js', import.meta.url);
  await mkdir(join(directory, 'analysis/routes'), { recursive: true });
  const traces: { route: (typeof routes)[number]; evidence: EliteEvidence }[] = [];
  for (const route of routes) {
    options.onProgress?.(`Recovering Elite: ${route.id}`);
    const evidence = await analyseInProcess<EliteJob, EliteEvidence>(worker, {
      checkpoint: boot.checkpoint,
      ...route,
    });
    await writeFile(
      join(directory, 'analysis/routes', route.id + '.json'),
      JSON.stringify({ ...evidence, pixels: undefined }),
    );
    traces.push({ route, evidence });
  }
  const flow = recoverStaticBranches(
    boot.checkpoint,
    traces.flatMap((trace) => trace.evidence.trace!.variants.map((variant) => variant.address)),
    { start: 0x800, end: 0x10000 },
  );
  const program = emitRecoveredProgram(
      traces.map((trace) => trace.evidence.trace!),
      {},
      [
        ...flow.instructions,
        ...knownMemoryInstructions(boot.checkpoint, { start: 0x0200, end: 0x10000 }),
      ],
    ),
    checks: { name: string; passed: boolean }[] = [];
  const temporary = await mkdtemp(join(tmpdir(), 'rom-studio-elite-'));
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
    const path = join(temporary, 'program.js');
    await writeStaticProgram(program, temporary);
    for (const trace of traces) {
      options.onProgress?.(`Checking exported Elite: ${trace.route.id}`);
      const replay = await analyseInProcess<EliteJob, EliteEvidence>(worker, {
        checkpoint: boot.checkpoint,
        frames: trace.route.frames,
        inputs: trace.evidence.inputs,
        program: pathToFileURL(path).href,
      });
      checks.push({
        name: trace.route.id + '-static-replay',
        passed:
          JSON.stringify(replay.fingerprint) === JSON.stringify(trace.evidence.fingerprint) &&
          replay.audioHash === trace.evidence.audioHash,
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('ELITE_PARITY', JSON.stringify(checks));
  }
  const example = traces.find((trace) => trace.route.id === 'example')!;
  const manifest = await packageWeb({
    directory,
    titleId: 'elite',
    system: c64BrowserPackage,
    checkpoint: boot.checkpoint,
    program,
    inputs: example.evidence.inputs,
    pixels: example.evidence.pixels,
    titleModules: ['games/c64/elite/player.js', 'games/c64/elite/web/title.js'],
    learning: [
      {
        source: join(repositoryRoot, 'src/games/c64/elite/README.md'),
        relative: 'learn/README.md',
      },
    ],
    manifest: {
      title: 'Elite',
      buildId: boot.report.bootId,
      build: {
        status: 'partial-title',
        artifact: 'static-commander-and-flight-study',
        playable: true,
      },
      verification: { referenceReplay: 'passed', hardwareParity: 'unverified', checks },
      backend: {
        kind: 'static-source-address-functions',
        shapes: program.shapes.length,
        dynamicCompilerInBrowser: false,
      },
      launch: {
        checkpoint: 'original-new-commander-title',
        timing: 'pal-6569',
        originalBootReplayedDuringBuild: true,
      },
      example: { controlFrames: example.route.frames, completion: false },
      audio: {
        kind: 'approximate-sid',
        samples: example.evidence.audioSamples,
        sampleReplay: 'passed',
      },
      media: { sha256: boot.report.media },
      limitations: [
        'Bounded new-commander, docked status, launch, flight and view controls. Saved commanders, trading, combat outcomes and full progression are unverified.',
        'Startup uses declared workspace, functional KERNAL services and a guarded discarded-read annotation; service timing is approximate.',
        'Video, SID and independent hardware parity remain unverified.',
      ],
    },
  });
  return { outputDirectory: directory, manifest };
}
