import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPCODES, decode } from '../transpiler/mos6502.js';
import { lift } from '../transpiler/lift.js';
import { Machine, RamBus } from './mos6502.js';

async function compile(bytes: Uint8Array, mutableOperands = false) {
  const source = lift([decode(bytes, 0x8000)], { mutableOperands });
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source.javascript).toString('base64')}`
  )) as { step(machine: Machine): void };
}
class ClockBus extends RamBus {
  readonly slots: { cycle: number; write: boolean }[] = [];
  cpuCycle = (cycle: number, write: boolean): number => {
    this.slots.push({ cycle, write });
    return 0;
  };
}
test('all documented instruction bus sequences retain CPU semantics and their nominal timing', async () => {
  for (const opcode of OPCODES.keys()) {
    for (const mutable of [false, true]) {
      const bytes = Uint8Array.from({ length: 65536 }, (_, index) => (index * 37 + 13) & 255);
      bytes.set([opcode, 0xfe, 0x90], 0x8000);
      const { step } = await compile(bytes, mutable),
        bus = new ClockBus(bytes),
        clocked = new Machine(bus),
        plain = new Machine(new RamBus(bytes));
      for (const s of [plain, clocked]) {
        s.pc = 0x8000;
        s.a = 0x42;
        s.x = 2;
        s.y = 3;
        s.sp = 255;
        s.p = 0x20;
      }
      if (opcode === 0) {
        assert.throws(() => step(clocked), /interrupt/);
        continue;
      }
      step(plain);
      step(clocked);
      assert.deepEqual(
        clocked.snapshot(),
        plain.snapshot(),
        `opcode ${opcode}, mutable ${mutable}`,
      );
      assert.deepEqual(bus.bytes, (plain.bus as RamBus).bytes);
      assert.equal(bus.slots.length, clocked.cycles, `opcode ${opcode}, mutable ${mutable}`);
      assert.deepEqual(
        bus.slots.map((slot) => slot.cycle),
        Array.from({ length: clocked.cycles }, (_, index) => index),
      );
    }
  }
});
test('RMW writes finish without RDY waits; read stalls move their physical cycles and total elapsed time', async () => {
  const bytes = new Uint8Array(65536);
  bytes.set([0xee, 0, 0x90], 0x8000);
  bytes[0x9000] = 42;
  const { step } = await compile(bytes, true),
    bus = new ClockBus(bytes),
    machine = new Machine(bus);
  machine.pc = 0x8000;
  bus.cpuCycle = (cycle, write) => {
    bus.slots.push({ cycle, write });
    return !write && cycle === 3 ? 5 : 0;
  };
  step(machine);
  assert.equal(machine.cycles, 11);
  assert.equal(bus.bytes[0x9000], 43);
  assert.deepEqual(
    bus.slots.filter((slot) => slot.write),
    [
      { cycle: 9, write: true },
      { cycle: 10, write: true },
    ],
  );
});
test('JSR puts return-address writes before the high-operand read, and stack instructions use their late slots', async () => {
  for (const [opcode, writes] of [
    [0x20, [3, 4]],
    [0x48, [2]],
    [0x08, [2]],
    [0x68, []],
    [0x28, []],
    [0x60, []],
    [0x40, []],
  ] as const) {
    const bytes = new Uint8Array(65536);
    bytes.set([opcode, 0, 0x90], 0x8000);
    const { step } = await compile(bytes, true),
      bus = new ClockBus(bytes),
      machine = new Machine(bus);
    machine.pc = 0x8000;
    step(machine);
    assert.deepEqual(
      bus.slots.filter((slot) => slot.write).map((slot) => slot.cycle),
      writes,
    );
  }
});
