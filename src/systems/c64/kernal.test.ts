import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../../memory.js';
import { Machine } from '../../runtime/mos6502.js';
import { C64SystemBus } from './system.js';

function editor() {
  const bus = new C64SystemBus(new AddressSpace()),
    machine = new Machine(bus);
  for (let address = 2; address < 0x400; address++) {
    bus.seed(address, 0);
  }
  bus.bytes[0x288] = 4;
  bus.bytes[0xd5] = 39;
  bus.bytes[0x286] = 14;
  const output = (character: number) => {
    machine.push(0x40);
    machine.push(2);
    machine.pc = 0xe716;
    machine.a = character;
    machine.x = 17;
    machine.y = 34;
    machine.p = 0x24;
    bus.boundary(machine);
    assert.equal(machine.pc, 0x4003);
    assert.equal(machine.sp, 0xfd);
    assert.equal(machine.a, character);
    assert.equal(machine.x, 17);
    assert.equal(machine.y, 34);
    assert.equal(machine.p & 5, 0);
  };
  return { bus, machine, output };
}
test('functional screen output converts PETSCII, applies color and advances row pointers', () => {
  const { bus, output } = editor();
  output(5);
  output(65);
  output(66);
  output(13);
  output(67);
  assert.deepEqual([...bus.bytes.subarray(0x400, 0x402)], [1, 2]);
  assert.equal(bus.bytes[0x428], 3);
  assert.equal(bus.colour[0], 1);
  assert.equal(bus.colour[40], 1);
  assert.equal(bus.bytes[0xd6], 1);
  assert.equal(bus.bytes[0xd3], 1);
  assert.equal(bus.bytes[0xd1], 40);
  assert.equal(bus.bytes[0xd2], 4);
  assert.equal(bus.bytes[0xf4], 0xd8);
});
test('unimplemented editor modes fail rather than silently inventing behavior', () => {
  const { bus, machine } = editor();
  bus.bytes[0xd8] = 1;
  machine.pc = 0xe716;
  assert.throws(() => bus.boundary(machine), /no insert/);
});
test('the direct keyboard-buffer entry reached by Elite uses the declared input contract', () => {
  const { bus, machine } = editor();
  bus.kernal.characterInput = () => 0x4e;
  machine.push(0x40);
  machine.push(0x1a);
  machine.pc = 0xf142;
  assert.equal(bus.boundary(machine), true);
  assert.equal(machine.pc, 0x401b);
  assert.equal(machine.a, 0x4e);
  assert.equal(bus.kernal.calls.at(-1)!.address, 0xf142);
});
