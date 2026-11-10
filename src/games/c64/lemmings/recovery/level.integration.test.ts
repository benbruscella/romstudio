import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levelTrial } from './level.js';
import { sampleTerrain } from '../code/level-data.js';
import { AddressSpace } from '../../../../memory.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
import { repositoryRoot } from '../../../../paths.js';
/** Compare the named terrain reader with the original machine instructions.
 * This is deliberately a separate execution path, not a second copy of its
 * address formula. Patch the same operands as $287E; probe at relative (0,8). */
function compareTerrainProbes(bytes: Uint8Array, known: Uint8Array): void {
  const space = new AddressSpace();
  space.bytes.set(bytes);
  space.loaded.set(known);
  const bus = new C64SystemBus(space);
  bus.write(1, 0x35); // Isolated RAM probe; gameplay banks ROM out before terrain reads.
  const memory = { bytes, known };
  for (const x of [0, 1, 2, 3, 12, 55, 56, 124, 255, 256, 317, 319]) {
    for (const y of [16, 47, 80, 115, 150, 168]) {
      const sample = sampleTerrain(memory, x, y);
      const high = x >>> 8,
        low = x & 255;
      for (const [address, value] of [
        [0x28ef, low],
        [0x28f0, 0x4a | high],
        [0x28f3, low],
        [0x28f4, 0x4c | high],
        [0x28fd, low],
        [0x28fe, 0x4e | high],
        [0x28f7, y - 8],
        [0x2900, y - 8],
        [0x290d, 0xc4 + (x & 3)],
      ]) {
        bus.write(address!, value!);
      }
      const s = new Machine(bus);
      s.pc = 0x28ec;
      s.x = 0;
      s.y = 8;
      s.p = 0x24;
      s.push(6);
      s.push(255);
      const result = recover(s, { stopAt: 0x700, maxInstructions: 40, maxVariants: 40 });
      assert.equal(result.stop, 'checkpoint', JSON.stringify(result.gap));
      assert.equal(s.word(0x290a), sample.address, `address at ${x},${y}`);
      assert.equal(s.a, (sample.pair << (6 - (x & 3) * 2)) & sample.mask, `pair at ${x},${y}`);
      assert.equal(s.a !== 0, sample.ordinaryProbe);
      // $291C is the original alternate probe's final pair classification.
      s.a = sample.pair;
      s.pc = 0x291c;
      s.push(6);
      s.push(255);
      const alternate = recover(s, { stopAt: 0x700, maxInstructions: 10, maxVariants: 10 });
      assert.equal(alternate.stop, 'checkpoint');
      assert.equal(s.a !== 0, sample.probeIgnoringThree);
    }
  }
  assert.throws(() => sampleTerrain(memory, 320, 80), /Reviewed/);
  assert.throws(
    () => sampleTerrain({ bytes, known: new Uint8Array(65536) }, 124, 80),
    /recovered byte/,
  );
}

test('two original level paths reach a first spawn; a changed prior-status fixture leaves recovered data unchanged', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/lemmings/LEMMING0.D64'));
  } catch {
    t.skip('Private trial media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-level-'));
  try {
    const first = await levelTrial({ outputDirectory: directory });
    assert.equal(first.report.status, 'first-lemming-spawned', JSON.stringify(first.report.gap));
    assert.equal(first.report.header!.name, 'Just dig!');
    assert.equal(first.report.header!.lemmingCount, 10);
    assert.deepEqual(first.report.header!.entrances, [{ x: 124, y: 47 }]);
    assert.deepEqual(first.report.header!.exits, [{ x: 189, y: 115 }]);
    assert.deepEqual(first.report.header!.time, { minutes: 5, seconds: 0 });
    assert.deepEqual(first.report.header!.skillStockBySlot, [0, 0, 0, 0, 0, 0, 0, 10]);
    assert.deepEqual(
      first.report.firstLemming && [first.report.firstLemming.x, first.report.firstLemming.y],
      [126, 52],
    );
    await access(join(first.outputDirectory, 'terrain.png'));
    compareTerrainProbes(
      await readFile(join(first.outputDirectory, 'memory.bin')),
      await readFile(join(first.outputDirectory, 'known-memory.bin')),
    );

    const second = await levelTrial({ outputDirectory: directory, level: 2 });
    assert.equal(second.report.status, 'first-lemming-spawned', JSON.stringify(second.report.gap));
    assert.equal(second.report.header!.name, 'Only floaters can survive this');
    assert.deepEqual(
      second.report.diskReads.slice(-2).map((read) => read.name),
      ['FB', 'SB'],
    );
    assert.deepEqual(second.report.header!.entrances, [{ x: 92, y: 16 }]);
    assert.deepEqual(second.report.header!.exits, [{ x: 209, y: 134 }]);
    assert.deepEqual(second.report.header!.skillStockBySlot, [0, 10, 0, 0, 0, 0, 0, 0]);
    assert.notEqual(second.report.hashes.terrain, first.report.hashes.terrain);
    compareTerrainProbes(
      await readFile(join(second.outputDirectory, 'memory.bin')),
      await readFile(join(second.outputDirectory, 'known-memory.bin')),
    );

    const changedFixture = await levelTrial({
      outputDirectory: directory,
      previousHeaderByte: 255,
    });
    assert.equal(
      changedFixture.report.status,
      'first-lemming-spawned',
      JSON.stringify(changedFixture.report.gap),
    );
    assert.deepEqual(changedFixture.report.header, first.report.header);
    assert.deepEqual(changedFixture.report.firstLemming, first.report.firstLemming);
    for (const key of ['header', 'terrain', 'collision'] as const) {
      assert.equal(changedFixture.report.hashes[key], first.report.hashes[key]);
    }
    assert.equal(first.report.verification.hardwareParity, 'unverified');
    assert.equal(first.report.build.playable, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
