import { serveAnalysis } from '../../../../analysis/process.js';
import { fingerprintPlayer, replayToControls } from '../../../../analysis/c64.js';
import { ElitePlayer } from '../player.js';
import { replayC64Controls, type RecordedControls } from '../../../../systems/c64/input.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
import { recover, type RecoveryResult } from '../../../../transpiler/recover.js';
import type { Machine } from '../../../../runtime/mos6502.js';
import { Diagnostic, sha256 } from '../../../../core.js';
export interface EliteJob {
  checkpoint: C64Checkpoint;
  frames: number;
  inputs: RecordedControls[];
  program?: string;
}
export interface EliteEvidence {
  trace?: RecoveryResult;
  fingerprint: ReturnType<typeof fingerprintPlayer>;
  inputs: RecordedControls[];
  pixels: Uint8Array;
  audioHash: string;
  audioSamples: number;
}
serveAnalysis<EliteJob, EliteEvidence>(async (job) => {
  const step = job.program
    ? ((await import(job.program)) as { step(machine: Machine): void }).step
    : () => {};
  const player = new ElitePlayer(job.checkpoint, step, replayC64Controls(job.inputs));
  player.enableAudio(44100);
  let trace: RecoveryResult | undefined;
  if (job.program) {
    replayToControls(player, job.frames, 22000000);
  } else {
    trace = recover(player.machine, {
      stopAt: 0xffff,
      stopWhen: () => player.controlFrames >= job.frames,
      maxInstructions: 20000000,
      maxVariants: 60000,
      maxBoundaryOperations: 150000,
      onFetch: (instruction) => player.bus.observe(instruction),
      onBoundary: () => player.boundary(),
    });
    if (trace.stop !== 'checkpoint') {
      throw new Diagnostic(
        'ELITE_COVERAGE',
        JSON.stringify({ stop: trace.stop, gap: trace.gap, recent: trace.recent }),
      );
    }
  }
  const audio = player.takeAudio();
  return {
    ...(trace ? { trace } : {}),
    fingerprint: fingerprintPlayer(player),
    inputs: player.inputs,
    pixels: player.display.pixels,
    audioHash: sha256(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)),
    audioSamples: audio.length,
  };
});
