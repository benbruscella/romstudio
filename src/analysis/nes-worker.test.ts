import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { analyseInProcess } from './process.js';
import { emitRecoveredProgram, writeStaticProgram } from '../transpiler/program.js';
import type { NesAnalysisJob, NesAnalysisResult } from './nes-worker.js';
import type { NesLaunch } from '../systems/nes/system.js';

test('original and static PCM keep the same video boundaries across OAM DMA', async (t) => {
  const prg = new Uint8Array(32768).fill(0xea);
  // Start a pulse, then arrange STA $4014 at CPU cycle 33,246. Its final
  // accesses cross the first PAL video boundary before the pending DMA runs.
  // An observer after DMA incorrectly puts its extra samples in frame one.
  prg.set([
    0x78, 0xa9, 0x0f, 0x8d, 0x15, 0x40, 0xa9, 0x3f, 0x8d, 0x00, 0x40, 0xa9, 0xfd, 0x8d, 0x02, 0x40,
    0xa9, 0x08, 0x8d, 0x03, 0x40,
  ]);
  prg.set(
    [
      0xa9,
      0x00, // LDA #0: setup ends at cycle 35.
      0xa0,
      0x19,
      0xa2,
      0xff,
      0xca,
      0xd0,
      0xfd,
      0x88,
      0xd0,
      0xf8, // 32,026 cycles.
      0xa2,
      0xec,
      0xca,
      0xd0,
      0xfd, // 1,181 cycles.
      0xea,
      0xea, // Four cycles: STA begins at 33,246.
      0x8d,
      0x14,
      0x40,
      0x4c,
      0x2b,
      0x80,
    ],
    0x15,
  );
  prg.set([0x00, 0x80], 0x7ffc);
  const launch: NesLaunch = {
    version: 1,
    system: 'nes',
    timing: 'pal-2a07',
    ramFill: 0,
    cartridge: { mapper: 0, mirroring: 'vertical', prg, chr: new Uint8Array(8192) },
  };
  const worker = new URL('./nes-worker.js', import.meta.url);
  const route = { id: 'dma-audio', frames: 3, inputs: [{ frame: 0, buttons: 0 }] };
  const original = await analyseInProcess<NesAnalysisJob, NesAnalysisResult>(worker, {
    launch,
    route,
  });
  assert.ok(original.audio.nonzeroSamples > 1000);
  const directory = await mkdtemp(join(tmpdir(), 'rom-studio-nes-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeStaticProgram(emitRecoveredProgram([original.trace!]), directory);
  const replay = await analyseInProcess<NesAnalysisJob, NesAnalysisResult>(worker, {
    launch,
    route,
    program: pathToFileURL(join(directory, 'program.js')).href,
    recording: original.inputs,
  });
  assert.deepEqual(replay.fingerprint, original.fingerprint);
  assert.deepEqual(replay.audio, original.audio);
  assert.equal(replay.audio.frames.length, 3);
});
