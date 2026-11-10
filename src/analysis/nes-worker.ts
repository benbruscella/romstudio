import { serveAnalysis } from './process.js';
import { NesPlayer, replayNesControls, type RecordedNesControls } from '../systems/nes/player.js';
import type { NesLaunch } from '../systems/nes/system.js';
import { recover, type RecoveryResult } from '../transpiler/recover.js';
import type { Machine } from '../runtime/mos6502.js';
import { Diagnostic, sha256 } from '../core.js';
import { createHash } from 'node:crypto';

export interface NesRoute {
  id: string;
  frames: number;
  inputs: { frame: number; buttons: number }[];
}
export interface NesAnalysisJob {
  launch: NesLaunch;
  route: NesRoute;
  program?: string;
  recording?: RecordedNesControls[];
  captureAudio?: boolean;
}
export interface NesAnalysisResult {
  trace?: RecoveryResult;
  inputs: RecordedNesControls[];
  pixels: Uint8Array;
  pcm?: Float32Array;
  audio: {
    sampleRate: number;
    samples: number;
    nonzeroSamples: number;
    peak: number;
    rms: number;
    sha256: string;
    frames: { frame: number; samples: number; sha256: string }[];
    registerWriters: { pc: number; address: number; writes: number; firstCycle: number }[];
    dmcReads: number;
  };
  fingerprint: { cpu: string; devices: string; pixels: string; inputs: string; audio: string };
  observations: {
    videoFrames: number;
    inputPolls: number;
    nmis: number;
    cpu: ReturnType<Machine['snapshot']>;
  };
}
serveAnalysis<NesAnalysisJob, NesAnalysisResult>(async (job) => {
  const step = job.program
    ? ((await import(job.program)) as { step: (machine: Machine) => void }).step
    : () => {};
  const replay = job.recording ? replayNesControls(job.recording) : undefined;
  let index = 0,
    buttons = 0;
  const player = new NesPlayer(job.launch, step, (frame) => {
    if (replay) {
      return replay(frame);
    }
    while (
      index < job.route.inputs.length &&
      job.route.inputs[index]!.frame <= player.display.frames
    ) {
      buttons = job.route.inputs[index++]!.buttons;
    }
    return { buttons };
  });
  const sampleRate = 48000;
  player.enableAudio(sampleRate);
  const audioHash = createHash('sha256');
  const audioFrames: NesAnalysisResult['audio']['frames'] = [];
  const writers = new Map<string, NesAnalysisResult['audio']['registerWriters'][number]>();
  const pcm: Float32Array[] = [];
  let lastVideoFrame = 0,
    samples = 0,
    nonzeroSamples = 0,
    peak = 0,
    sumSquares = 0;
  player.bus.apu.onWrite = (address, _value, cycle) => {
    const pc = player.machine.pc,
      key = `${pc}:${address}`;
    const previous = writers.get(key);
    if (previous) {
      previous.writes++;
    } else {
      writers.set(key, { pc, address, writes: 1, firstCycle: cycle });
    }
  };
  // Drain at identical original-machine video boundaries in both executions.
  // Keep per-frame PCM fingerprints so an early mismatch cannot hide behind
  // an equal final register snapshot. Host sampling does not drive the APU.
  const observeAudio = () => {
    if (player.display.frames === lastVideoFrame) {
      return;
    }
    lastVideoFrame = player.display.frames;
    const values = player.takeAudio(),
      bytes = Buffer.alloc(values.length * 4);
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      bytes.writeFloatLE(value, index * 4);
      nonzeroSamples += Number(Math.abs(value) > 0.000001);
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
    }
    samples += values.length;
    audioHash.update(bytes);
    audioFrames.push({ frame: lastVideoFrame, samples: values.length, sha256: sha256(bytes) });
    if (job.captureAudio) {
      pcm.push(values);
    }
  };
  const boundary = () => {
    const handled = player.boundary();
    observeAudio();
    return handled;
  };
  let trace: RecoveryResult | undefined;
  if (job.program) {
    let operations = 0;
    while (player.display.frames < job.route.frames) {
      // Recovery's stopWhen observes immediately after the preceding opcode,
      // before servicing DMA/interrupts. Match that boundary in static replay
      // as well, or identical PCM can be grouped into different video frames.
      observeAudio();
      if (++operations > 50000000) {
        throw new Diagnostic(
          'NES_REPLAY_BUDGET',
          'Static replay exceeded its instruction/service bound.',
        );
      }
      if (!boundary()) {
        step(player.machine);
      }
    }
  } else {
    trace = recover(player.machine, {
      stopAt: 0xffff,
      stopWhen: () => {
        observeAudio();
        return player.display.frames >= job.route.frames;
      },
      maxInstructions: 50000000,
      maxVariants: 50000,
      maxBoundaryOperations: 500000,
      onBoundary: boundary,
    });
    if (trace.stop !== 'checkpoint') {
      throw new Diagnostic(
        'NES_COVERAGE',
        JSON.stringify({
          route: job.route.id,
          stop: trace.stop,
          gap: trace.gap,
          recent: trace.recent,
        }),
      );
    }
  }
  observeAudio();
  const audio: NesAnalysisResult['audio'] = {
    sampleRate,
    samples,
    nonzeroSamples,
    peak,
    rms: samples ? Math.sqrt(sumSquares / samples) : 0,
    sha256: audioHash.digest('hex'),
    frames: audioFrames,
    registerWriters: [...writers.values()],
    dmcReads: player.bus.apu.dmc.reads,
  };
  const captured = job.captureAudio ? new Float32Array(samples) : undefined;
  let offset = 0;
  if (captured) {
    for (const chunk of pcm) {
      captured.set(chunk, offset);
      offset += chunk.length;
    }
  }
  return {
    ...(trace ? { trace } : {}),
    inputs: player.inputs,
    pixels: player.display.pixels,
    ...(captured ? { pcm: captured } : {}),
    audio,
    fingerprint: {
      cpu: sha256(JSON.stringify(player.machine.snapshot())),
      devices: sha256(JSON.stringify(player.bus.snapshot())),
      pixels: sha256(player.display.pixels),
      inputs: sha256(JSON.stringify(player.inputs)),
      audio: sha256(JSON.stringify(audio)),
    },
    observations: {
      videoFrames: player.display.frames,
      inputPolls: player.controlFrames,
      nmis: player.bus.nmiEntries,
      cpu: player.machine.snapshot(),
    },
  };
});
