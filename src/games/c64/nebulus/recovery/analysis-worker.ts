import { serveAnalysis } from '../../../../analysis/process.js';
import { fingerprintPlayer, replayToControls } from '../../../../analysis/c64.js';
import { recover, type RecoveryResult } from '../../../../transpiler/recover.js';
import type { Machine } from '../../../../runtime/mos6502.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
import { replayC64Controls, type RecordedControls } from '../../../../systems/c64/input.js';
import { NebulusPlayer } from '../player.js';
import { nebulusExtensions } from './game.js';
import { Diagnostic } from '../../../../core.js';

export interface NebulusAnalysisJob {
  checkpoint: C64Checkpoint;
  id: string;
  frames: number;
  inputs: RecordedControls[];
  capture: boolean;
  program?: string;
}
export interface NebulusAnalysisResult {
  trace?: RecoveryResult;
  fingerprint: ReturnType<typeof fingerprintPlayer>;
  stats: ReturnType<NebulusPlayer['stats']>;
  bounds: { minRotation: number; maxRotation: number; minLives: number };
  inputs: RecordedControls[];
  logicTicks: number;
  waitingToStart: boolean;
  audio?: Float32Array;
  pixels?: Uint8Array;
}
serveAnalysis<NebulusAnalysisJob, NebulusAnalysisResult>(async (job) => {
  const step = job.program
    ? ((await import(job.program)) as { step: (machine: Machine) => void }).step
    : () => {};
  const player = new NebulusPlayer(
    job.checkpoint,
    step,
    replayC64Controls(job.inputs),
    job.capture,
  );
  if (job.capture) {
    player.enableAudio(44100);
  }
  const first = player.stats(),
    bounds = { minRotation: first.rotation, maxRotation: first.rotation, minLives: first.lives };
  let trace: RecoveryResult | undefined;
  if (job.program) {
    replayToControls(player, job.frames, 22000000);
  } else {
    trace = recover(player.machine, {
      stopAt: 0xffff,
      stopWhen: () => player.controlFrames >= job.frames,
      maxInstructions: 20000000,
      maxVariants: 50000,
      maxBoundaryOperations: 150000,
      undocumentedOpcodes: nebulusExtensions,
      onFetch: (instruction) => player.bus.observe(instruction),
      onBoundary: () => {
        if (player.machine.pc === 0x80ab) {
          const s = player.stats();
          bounds.minRotation = Math.min(bounds.minRotation, s.rotation);
          bounds.maxRotation = Math.max(bounds.maxRotation, s.rotation);
          bounds.minLives = Math.min(bounds.minLives, s.lives);
        }
        return player.boundary();
      },
    });
    if (trace.stop !== 'checkpoint') {
      throw new Diagnostic(
        'NEBULUS_COVERAGE',
        JSON.stringify({ route: job.id, stop: trace.stop, gap: trace.gap }),
      );
    }
  }
  return {
    ...(trace ? { trace } : {}),
    fingerprint: fingerprintPlayer(player),
    stats: player.stats(),
    bounds,
    inputs: player.inputs,
    logicTicks: player.logicTicks,
    waitingToStart: player.waitingToStart,
    ...(job.capture ? { audio: player.takeAudio(), pixels: player.display.pixels } : {}),
  };
});
