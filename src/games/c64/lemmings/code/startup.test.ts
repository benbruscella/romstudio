import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../../../../memory.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { inspectCompressedBlocks, LemmingsBoot } from './startup.js';
test('packed files contain bounded big-endian headers and can contain several blocks', () => {
  const bytes = Uint8Array.from([0, 1, 0x12, 0x34, 0x80, 0x41, 0, 0, 0xab, 0xcd, 0x40]);
  assert.deepEqual(inspectCompressedBlocks(bytes), [
    { headerOffset: 0, compressedBytes: 1, destinationEnd: 0x1234, initialBitBuffer: 0x80 },
    { headerOffset: 6, compressedBytes: 0, destinationEnd: 0xabcd, initialBitBuffer: 0x40 },
  ]);
  assert.throws(() => inspectCompressedBlocks(bytes.subarray(0, 5)), /overruns/);
  assert.throws(() => inspectCompressedBlocks(bytes.subarray(0, 8)), /Truncated/);
  assert.throws(() => inspectCompressedBlocks(new Uint8Array()), /no blocks/);
});

test('reviewed relocation preserves unknown padding instead of manufacturing known zeroes', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    machine = new Machine(bus);
  const title = new LemmingsBoot(bus, machine);
  const code = [
    0xa0, 0, 0xb1, 2, 0x91, 4, 0xc8, 0xd0, 0xf9, 0xe6, 5, 0xe6, 3, 0xd0, 0xf1, 0xa9, 0x37, 0x85, 1,
    0x58, 0x4c, 1, 8,
  ];
  code.forEach((byte, index) => bus.write(0x405 + index, byte));
  bus.write(2, 1);
  bus.write(3, 0x39);
  bus.write(4, 1);
  bus.write(5, 8);
  bus.write(1, 0x34);
  bus.write(0x3901, 0x42);
  bus.bytes[0x3903] = 0xaa;
  machine.pc = 0x405;
  machine.p = 0xa5;
  title.relocateLoaderPayload(machine);
  assert.equal(bus.read(0x801), 0x42);
  assert.equal(bus.bytes[0x803], 0xaa);
  assert.throws(() => bus.read(0x803), /not been loaded/);
  assert.equal(bus.read(0xcf00), 0x2f); // Wrapped final source byte is the DDR at $0000.
  assert.deepEqual([machine.pc, machine.a, machine.y, machine.p], [0x801, 0x37, 0, 0x21]);
  assert.equal(machine.instructions, 204576);
  assert.equal(machine.cycles, 818098);
});

test('trainer automation answers matched Y/N callers and leaves other GETIN callers empty', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    machine = new Machine(bus);
  const title = new LemmingsBoot(bus, machine);
  [0xc9, 0x59, 0xf0, 7, 0xc9, 0x4e].forEach((byte, index) => bus.write(0x9056 + index, byte));
  machine.pc = 0xffe4;
  machine.push(0x90);
  machine.push(0x55);
  title.boundary(machine);
  assert.equal(machine.a, 0x4e);
  assert.equal(machine.pc, 0x9056);
  assert.equal(title.inputs[0]!.caller, 0x9056);
  machine.pc = 0xffe4;
  machine.push(0x80);
  machine.push(0);
  title.boundary(machine);
  assert.equal(machine.a, 0);
  assert.equal(title.inputs.length, 1);
});

test('first-unpacker code at $0405 cannot accidentally trigger the later relocation annotation', () => {
  const space = new AddressSpace();
  space.loadPrg(Uint8Array.from([5, 4, 0xa9, 0x1b]));
  const bus = new C64SystemBus(space),
    machine = new Machine(bus);
  machine.pc = 0x405;
  assert.equal(new LemmingsBoot(bus, machine).boundary(machine), false);
  assert.equal(machine.pc, 0x405);
});
