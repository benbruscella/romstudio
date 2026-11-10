import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';
import { repositoryRoot, gameBuildDirectory } from '../paths.js';
import { rawNesChips } from '../media/nes.js';
import { NesSystemBus, type NesLaunch } from '../systems/nes/system.js';
import { nesBrowserPackage } from '../systems/nes.js';
import { analyseInProcess } from './process.js';
import {
  emitRecoveredProgram,
  recoverStaticBranches,
  writeStaticProgram,
} from '../transpiler/program.js';
import { packageWeb } from '../build/web-package.js';
import { listing, decode } from '../transpiler/mos6502.js';
import type { Mirroring } from '../systems/nes/cartridge.js';
import type { NesRoute, NesAnalysisJob, NesAnalysisResult } from './nes-worker.js';
import type { StartupOptions } from '../startup.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { nesProgramInstructions } from './nes-code.js';
import { pcm16Wave } from './audio-file.js';

export interface NesGameStudy {
  id: string;
  title: string;
  routes: readonly NesRoute[];
}
export type NesBuildOptions = StartupOptions & {
  onProgress?: (message: string) => void;
  /** Run the original/static comparisons (exported-program replay of every route
   * with fingerprint and per-frame PCM checks). Default true, as `verify-game`
   * and tests need. `false` packages the same files from original recovery alone
   * and records the reference replay as 'not-run'. */
  verify?: boolean;
};
/** Common NES recovery and packaging. Per-game choices and input routes are
 * data supplied by the study; cartridge/PPU behavior stays in the system. */
export async function buildNesGame(study: NesGameStudy, options: NesBuildOptions = {}) {
  const verify = options.verify ?? true;
  const recipeBytes = await readBounded(
    options.recipePath ?? join(repositoryRoot, `src/games/nes/${study.id}/recipe.json`),
    65536,
  );
  const recipe = JSON.parse(recipeBytes.toString()) as {
    system: string;
    timing: string;
    mapper: number;
    mirroring: string;
    mediaDirectory: string;
    media: { name: string; role: string; sha256: string }[];
  };
  if (recipe.system !== 'nes' || recipe.timing !== 'pal-2a07') {
    throw new Diagnostic('NES_RECIPE', 'Expected an explicit PAL NES recipe.');
  }
  const chips = new Map<string, Uint8Array>();
  for (const item of recipe.media) {
    if (
      item.name.includes('/') ||
      item.name.includes('\\') ||
      !['prg', 'chr'].includes(item.role) ||
      chips.has(item.role)
    ) {
      throw new Diagnostic('NES_MEDIA', 'Invalid or repeated chip role.');
    }
    const bytes = await readBounded(
      join(options.mediaDirectory ?? join(repositoryRoot, recipe.mediaDirectory), item.name),
      1048576,
    );
    if (sha256(bytes) !== item.sha256) {
      throw new Diagnostic('MEDIA_HASH', `SHA-256 mismatch for ${item.name}.`);
    }
    chips.set(item.role, bytes);
  }
  if (!chips.has('prg') || !chips.has('chr')) {
    throw new Diagnostic('NES_MEDIA', 'This study requires pinned PRG and CHR chips.');
  }
  const media = rawNesChips(chips.get('prg')!, chips.get('chr')!, {
    mapper: recipe.mapper,
    mirroring:
      recipe.mirroring === 'mapper-controlled' ? 'vertical' : (recipe.mirroring as Mirroring),
  });
  const launch: NesLaunch = {
    version: 1,
    system: 'nes',
    timing: 'pal-2a07',
    ramFill: 0,
    cartridge: { ...media.cartridge, prg: [...media.cartridge.prg], chr: [...media.cartridge.chr] },
  };
  const directory = resolve(options.outputDirectory ?? gameBuildDirectory(`nes/${study.id}`));
  await mkdir(join(directory, 'analysis'), { recursive: true });
  const worker = new URL('./nes-worker.js', import.meta.url),
    traces: { route: NesRoute; result: NesAnalysisResult }[] = [];
  for (const route of study.routes) {
    options.onProgress?.(`Recovering ${study.title}: ${route.id}`);
    const result = await analyseInProcess<NesAnalysisJob, NesAnalysisResult>(worker, {
      launch,
      route,
      captureAudio: route.id === 'example',
    });
    if (result.pcm) {
      await writeFile(
        join(directory, `analysis/${route.id}.wav`),
        pcm16Wave(result.pcm, result.audio.sampleRate),
      );
    }
    await writeFile(
      join(directory, `analysis/${route.id}.json`),
      JSON.stringify({ ...result, pixels: undefined, pcm: undefined }),
    );
    delete result.pcm;
    traces.push({ route, result });
  }
  const bus = new NesSystemBus(launch),
    memory = bus.memoryImage();
  const seeds = [0xfffa, 0xfffc, 0xfffe].map((at) => bus.peek(at) | (bus.peek(at + 1) << 8));
  const controlFlow = recoverStaticBranches(
    memory,
    [
      ...seeds,
      ...traces.flatMap((trace) => trace.result.trace!.variants.map((variant) => variant.address)),
    ],
    { start: 0x8000, end: 0x10000 },
  );
  const program = emitRecoveredProgram(
    traces.map((trace) => trace.result.trace!),
    {},
    [...controlFlow.instructions, ...nesProgramInstructions(launch)],
  );
  const scratch = new Uint8Array(65536),
    instructions = traces[0]!.result.trace!.variants.map((variant) => {
      variant.bytes.forEach((byte, offset) => {
        scratch[(variant.address + offset) & 65535] = byte;
      });
      return decode(scratch, variant.address);
    });
  await writeFile(join(directory, 'analysis/original.asm'), listing(instructions));
  const checks: { name: string; passed: boolean }[] = [];
  // The exported-program replays only feed the checks below; package files never use them.
  if (verify) {
    const temporary = await mkdtemp(join(tmpdir(), 'rom-studio-nes-'));
    try {
      await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
      const path = join(temporary, 'program.js');
      await writeStaticProgram(program, temporary);
      for (const trace of traces) {
        options.onProgress?.(`Checking exported ${study.title}: ${trace.route.id}`);
        const replay = await analyseInProcess<NesAnalysisJob, NesAnalysisResult>(worker, {
          launch,
          route: trace.route,
          program: pathToFileURL(path).href,
          recording: trace.result.inputs,
        });
        await writeFile(
          join(directory, `analysis/${trace.route.id}-replay.json`),
          JSON.stringify({ ...replay, pixels: undefined }),
        );
        checks.push({
          name: trace.route.id + '-static-replay',
          passed: JSON.stringify(replay.fingerprint) === JSON.stringify(trace.result.fingerprint),
        });
        checks.push({
          name: trace.route.id + '-per-frame-pcm',
          passed: JSON.stringify(replay.audio) === JSON.stringify(trace.result.audio),
        });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  checks.push({
    name: 'original-input-and-nmi',
    passed: traces.every(
      (trace) => trace.result.observations.inputPolls > 0 && trace.result.observations.nmis > 0,
    ),
  });
  checks.push({
    name: 'static-code',
    passed: !/\b(?:eval|new Function)\s*\(/.test(program.javascript),
  });
  const example = traces.find((trace) => trace.route.id === 'example') ?? traces[0]!;
  checks.push({
    name: 'original-audio-not-silent',
    passed: example.result.audio.nonzeroSamples > 1000 && example.result.audio.peak > 0.001,
  });
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('NES_PARITY', JSON.stringify(checks));
  }
  const manifest = await packageWeb({
    directory,
    titleId: study.id,
    system: nesBrowserPackage,
    checkpoint: launch,
    inputs: example.result.inputs,
    pixels: example.result.pixels,
    program,
    titleModules: [`games/nes/${study.id}/web/title.js`, 'systems/nes/title.js'],
    learning: ['README.md', 'docs/STARTUP.md', 'docs/AUDIO.md'].map((name) => ({
      source: join(repositoryRoot, `src/games/nes/${study.id}`, name),
      relative: 'learn/' + name,
    })),
    manifest: {
      title: study.title,
      buildId: sha256(recipeBytes),
      build: { status: 'release-ready', artifact: 'static-nes-browser-study', playable: true },
      verification: {
        referenceReplay: verify ? 'passed' : 'not-run',
        hardwareParity: 'unverified',
        checks,
        observations: traces.map((trace) => ({ id: trace.route.id, ...trace.result.observations })),
      },
      backend: {
        kind: 'static-source-address-functions',
        shapes: program.shapes.length,
        dynamicCompilerInBrowser: false,
      },
      launch: {
        checkpoint: 'original-reset-vector',
        timing: launch.timing,
        fixture: { ramFill: launch.ramFill },
        mapper: recipe.mapper,
      },
      example: { controlFrames: example.result.observations.inputPolls, completion: false },
      media: media.identity,
      audio: {
        source: 'original-2a07-register-writes',
        model:
          'PAL pulse/triangle/noise/DMC with nonlinear mixing and approximate analogue filters',
        sampleRate: example.result.audio.sampleRate,
        channels: 1,
        samples: example.result.audio.samples,
        nonzeroSamples: example.result.audio.nonzeroSamples,
        sha256: example.result.audio.sha256,
        perVideoFrameReplay: verify ? 'passed' : 'not-run',
        observations: traces.map(({ route, result }) => ({
          id: route.id,
          frames: result.audio.frames.length,
          peak: result.audio.peak,
          rms: result.audio.rms,
          nonzeroSamples: result.audio.nonzeroSamples,
          dmcReads: result.audio.dmcReads,
          registerWriters: result.audio.registerWriters,
        })),
      },
      limitations: [
        'Bounded startup and gameplay routes; later levels and complete progression are unverified.',
        'Analogue audio response, exact DMA overlap/interrupt races, precise PPU fetch phases, reset warm-up and independent hardware parity remain unverified.',
        'RAM power-on fill is an explicit fixture; raw-chip board identity and PAL timing come from the recipe.',
      ],
    },
  });
  return { outputDirectory: directory, manifest };
}
