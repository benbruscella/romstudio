import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digTrial } from '../recovery/dig.js';
import { repositoryRoot } from '../../../../paths.js';
import {
  assignDigger,
  readLemming,
  readSkillStock,
  eraseTerrainPair,
  updateDiggerStroke,
} from './digger.js';
import { AddressSpace } from '../../../../memory.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
function fixture(bytes: Uint8Array, known: Uint8Array) {
  const space = new AddressSpace();
  space.bytes.set(bytes);
  space.loaded.set(known);
  const bus = new C64SystemBus(space);
  bus.write(1, 0x35);
  return bus;
}

function originalCall(bus: C64SystemBus, pc: number) {
  const s = new Machine(bus);
  s.pc = pc;
  s.push(6);
  s.push(255);
  const result = recover(s, { stopAt: 0x700, maxInstructions: 1000, maxVariants: 1000 });
  assert.equal(result.stop, 'checkpoint', JSON.stringify(result.gap));
  return s;
}

function compareIsolatedRoutines(bytes: Uint8Array, known: Uint8Array): void {
  // Enter the original click dispatcher, so its stock check is included too.
  for (const mode of [0, 1, 2, 6, 8, 9, 16, 17, 0x88, 0x89]) {
    for (const stock of [0, 1, 10]) {
      const bus = fixture(bytes, known);
      for (const [address, value] of [
        [0x5bf, 128],
        [0x5c4, 128],
        [0x5c1, 0],
        [0x5c0, 7],
        [0x5cf, Math.floor(stock / 10)],
        [0x5d9, stock % 10],
        [0x424, mode],
        [0x456, 0x32],
        [0x51e, 0x04],
      ]) {
        bus.write(address!, value!);
      }
      const expected = assignDigger(readLemming(bus, 0), stock);
      originalCall(bus, 0x1501);
      assert.deepEqual(readLemming(bus, 0), expected.actor, `mode ${mode}, stock ${stock}`);
      assert.equal(readSkillStock(bus, 7), expected.stock);
    }
  }
  for (const x of [0, 55, 56, 124, 255, 256, 319]) {
    for (const scroll of [0, 26, 70]) {
      const y = 90,
        bus = fixture(bytes, known);
      const shadow = { bytes: Uint8Array.from(bytes), known: Uint8Array.from(known) };
      bus.write(0x40d, scroll);
      shadow.bytes[0x40d] = scroll;
      const expected = eraseTerrainPair(shadow, x, y);
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
        [0x298d, 0xc4 + (x & 3)],
        [0x1461, high],
        [0xba, 0],
      ]) {
        bus.write(address!, value!);
      }
      const s = new Machine(bus);
      s.pc = 0x2930;
      s.x = 0;
      s.y = 8;
      s.push(6);
      s.push(255);
      const result = recover(s, { stopAt: 0x700, maxInstructions: 150, maxVariants: 150 });
      assert.equal(result.stop, 'checkpoint', JSON.stringify(result.gap));
      assert.equal(bus.read(0xba), expected.occupied ? 1 : 0);
      assert.deepEqual(
        bus.bytes.subarray(0x8000, 0xb400),
        shadow.bytes.subarray(0x8000, 0xb400),
        `world: x=${x}, scroll=${scroll}`,
      );
      assert.deepEqual(
        bus.bytes.subarray(0x6000, 0x7000),
        shadow.bytes.subarray(0x6000, 0x7000),
        `display: x=${x}, scroll=${scroll}`,
      );
    }
  }
  const special = fixture(bytes, known);
  special.write(0xe07c, 1);
  assert.throws(
    () => updateDiggerStroke(special, { x: 127, y: 71, mode: 6, animation: 0, extra: 0 }),
    /Special-terrain/,
  );
}

test('the original input path and a recorded replay agree with raised digger state and terrain writes', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/lemmings/LEMMING0.D64'));
  } catch {
    t.skip('Private trial media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-digger-'));
  try {
    const first = await digTrial({ outputDirectory: directory });
    assert.equal(first.report.status, 'digger-path-verified', JSON.stringify(first.report.gap));
    assert.equal(first.report.assignment.length, 1);
    assert.equal(first.report.skillStock, 9);
    assert.deepEqual(first.report.strokeComparisons, { count: 134, passed: 134 });
    assert.equal(first.report.terrainChanges.length, 139);
    assert.equal(first.report.firstLemming.mode & 31, 8);
    assert.ok(first.report.inputs.some((input) => input.key8));
    assert.ok(first.report.inputs.some((input) => !(input.joystick & 16)));
    await access(join(first.outputDirectory, 'terrain-after.png'));
    compareIsolatedRoutines(
      await readFile(join(first.outputDirectory, 'memory-before.bin')),
      await readFile(join(first.outputDirectory, 'known-memory-before.bin')),
    );
    const replay = await digTrial({ outputDirectory: directory, inputReplay: first.report.inputs });
    assert.equal(replay.report.status, 'digger-path-verified');
    assert.deepEqual(replay.report.hashes, first.report.hashes);
    assert.deepEqual(replay.report.state, first.report.state);
    assert.equal(replay.report.verification.hardwareParity, 'unverified');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
