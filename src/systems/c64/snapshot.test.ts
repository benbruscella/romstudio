import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../../memory.js';
import { Machine } from '../../runtime/mos6502.js';
import { C64SystemBus } from './system.js';
import { captureC64, restoreC64 } from './snapshot.js';

test('running C64 checkpoints preserve banking, unknown RAM, timer/IRQ latches and keyboard switches', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    machine = new Machine(bus);
  bus.write(1, 0x35);
  bus.write(0x8000, 0x42);
  bus.write(0xdc04, 20);
  bus.write(0xdc05, 0);
  bus.write(0xdc0e, 17);
  bus.cia1.setKey(3, 3, true);
  bus.cia1.inputA = 239;
  bus.vic.irqFlags = 1;
  bus.vic.irqMask = 1;
  bus.advanceTo(1000);
  machine.cycles = 1007;
  machine.pc = 0x8000;
  machine.instructions = 99;
  const checkpoint = captureC64(bus, machine),
    restored = restoreC64(checkpoint);
  assert.deepEqual(captureC64(restored.bus, restored.machine), checkpoint);
  assert.equal(restored.bus.read(1), 0x35);
  assert.throws(() => restored.bus.read(0x2345), /not been loaded/);
  bus.advanceTo(1005);
  restored.bus.advanceTo(1005);
  assert.deepEqual(captureC64(restored.bus, restored.machine), captureC64(bus, machine));
  const invalid = structuredClone(checkpoint);
  invalid.cpu.pc = 65536;
  assert.throws(() => restoreC64(invalid), /Invalid C64 checkpoint/);
});
