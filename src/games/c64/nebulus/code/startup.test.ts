import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
import { AddressSpace } from '../../../../memory.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { NebulusStartup } from './startup.js';
const relocation = [
  0xa2, 6, 0xa0, 0, 0xb9, 0x27, 0x69, 0x49, 8, 0x99, 0, 0xc9, 0xc8, 0xd0, 0xf5, 0xee, 0x12, 0x69,
  0xee, 0x17, 0x69, 0xca, 0xd0, 0xec, 0x4c, 0xd9, 0xca,
];

function xorFixture() {
  const space = new AddressSpace();
  space.loaded.fill(1);
  space.bytes.set(relocation, 0x690c);
  for (let index = 0; index < 1536; index++) {
    space.bytes[0x6927 + index] = (index * 37 + 11) & 255;
  }
  space.bytes[0x6b00] = 0xa1;
  space.bytes[0x6b01] = 8; // Decodes to LDA #$00 at $CAD9.
  const bus = new C64SystemBus(space),
    machine = new Machine(bus);
  machine.pc = 0x690c;
  machine.p = 0x65;
  return { bus, machine };
}

test('raised XOR relocation agrees with original instructions, memory and exact CPU counts on fully known input', () => {
  const original = xorFixture(),
    raised = xorFixture();
  const result = recover(original.machine, {
    stopAt: 0xcadb,
    maxInstructions: 10000,
    maxVariants: 100,
    onFetch: (instruction) => original.bus.observe(instruction),
    onBoundary: (s) => original.bus.boundary(s),
  });
  assert.equal(result.stop, 'checkpoint');
  new NebulusStartup(raised.bus).relocateTrainer(raised.machine);
  assert.deepEqual(raised.machine.snapshot(), original.machine.snapshot());
  assert.equal(raised.machine.instructions, 7708);
  assert.equal(raised.machine.cycles, 24914);
  assert.deepEqual(raised.bus.bytes, original.bus.bytes);
  assert.deepEqual(raised.bus.known, original.bus.known);
});

test('XOR relocation retains unknown padding and rejects changed instruction bytes', () => {
  const { bus, machine } = xorFixture();
  bus.known.fill(0, 0x6e43, 0x6f27);
  new NebulusStartup(bus).relocateTrainer(machine);
  assert.ok(bus.known.subarray(0xc900, 0xce1c).every(Boolean));
  assert.ok(bus.known.subarray(0xce1c, 0xcf00).every((value) => value === 0));
  assert.equal(machine.a, 0);
  assert.equal(machine.pc, 0xcadb);
  const changed = xorFixture();
  changed.bus.bytes[0x690c] = 0xea;
  assert.throws(
    () => new NebulusStartup(changed.bus).relocateTrainer(changed.machine),
    /instruction bytes changed/,
  );
});

test('Nebulus services leave banked RAM at KERNAL entry addresses executable', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    s = new Machine(bus),
    title = new NebulusStartup(bus);
  s.write(1, 0x35);
  s.a = 0x93;
  for (const address of [0xffd2, 0xffd5, 0xffe4]) {
    s.write(address, 0xea);
    s.pc = address;
    assert.equal(title.boundary(s), false);
    assert.equal(s.pc, address);
    assert.equal(s.bus.peek(address), 0xea);
  }
  assert.equal(title.diskReads.length, 0);
  assert.equal(title.screenClears, 0);
  assert.deepEqual(title.inputs, []);
});
