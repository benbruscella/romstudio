import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../memory.js';
import { Machine, RamBus } from '../runtime/mos6502.js';
import { recover } from './recover.js';
import { C64RecoveryBus } from '../systems/c64.js';

test('trace-guided lifting recovers changed operands and preserves a self-modifying program', () => {
  const bus = new RamBus();
  bus.bytes.set(
    [0xa2, 3, 0xa9, 0, 0x9d, 0, 0x90, 0xee, 3, 0x80, 0xca, 0x10, 0xf5, 0x4c, 0x10, 0x80, 0xea],
    0x8000,
  );
  const machine = new Machine(bus);
  machine.pc = 0x8000;
  const result = recover(machine, { stopAt: 0x8010, maxInstructions: 100, maxVariants: 100 });
  assert.equal(result.stop, 'checkpoint');
  assert.equal(result.state.instructions, 22);
  assert.equal(result.state.cycles, 76);
  assert.deepEqual([...bus.bytes.subarray(0x9000, 0x9004)], [3, 2, 1, 0]);
  assert.equal(result.invalidations, 3);
  assert.deepEqual(
    result.variants.filter((v) => v.address === 0x8002).map((v) => v.bytes[1]),
    [0, 1, 2, 3],
  );
});
test('recovery bounds looping code and decoded variants', () => {
  const bus = new RamBus();
  bus.bytes.set([0x4c, 0, 0x80], 0x8000);
  const m = new Machine(bus);
  m.pc = 0x8000;
  assert.equal(
    recover(m, { stopAt: 0x9000, maxInstructions: 20, maxVariants: 5 }).stop,
    'instruction-budget',
  );
  assert.equal(m.instructions, 20);
  bus.bytes.set([0xea, 0xea, 0xea], 0x8000);
  m.pc = 0x8000;
  assert.equal(
    recover(m, { stopAt: 0x9000, maxInstructions: 20, maxVariants: 2 }).stop,
    'variant-budget',
  );
});
test('recovery keeps opcode changes distinct while retaining every operand epoch', () => {
  const bus = new RamBus();
  bus.bytes.set([0xa9, 42], 0x8000);
  const machine = new Machine(bus);
  machine.pc = 0x8000;
  const result = recover(machine, {
    stopAt: 0xffff,
    stopWhen: (s) => s.instructions === 3,
    maxInstructions: 10,
    maxVariants: 10,
    onBoundary: () => {
      if (machine.pc === 0x8002) {
        bus.bytes[0x8000] = 0xa2;
        bus.bytes[0x8001] = machine.instructions === 1 ? 43 : 44;
        machine.pc = 0x8000;
      }
      return false;
    },
  });
  assert.equal(result.stop, 'checkpoint');
  assert.equal(machine.a, 42);
  assert.equal(machine.x, 44);
  assert.equal(result.invalidations, 2);
  assert.equal(machine.cycles, 6);
  assert.deepEqual(
    result.variants.map((v) => v.bytes),
    [
      [0xa9, 42],
      [0xa2, 43],
      [0xa2, 44],
    ],
  );
});

test('state-dependent checkpoints stop before the next instruction and retain budget limits', () => {
  const bus = new RamBus();
  bus.bytes.set([0xe8, 0x4c, 0, 0x80], 0x8000);
  const m = new Machine(bus);
  m.pc = 0x8000;
  const stopped = recover(m, {
    stopAt: 0x9000,
    stopWhen: (s) => s.x === 3,
    maxInstructions: 20,
    maxVariants: 5,
  });
  assert.equal(stopped.stop, 'checkpoint');
  assert.equal(m.pc, 0x8001);
  assert.equal(m.instructions, 5);
  const bounded = recover(m, {
    stopAt: 0x9000,
    stopWhen: () => false,
    maxInstructions: 4,
    maxVariants: 5,
  });
  assert.equal(bounded.stop, 'instruction-budget');
  assert.equal(m.instructions, 9);
});
test('C64 recovery traps unknown state and respects RAM banking beneath devices and ROM', () => {
  const space = new AddressSpace(),
    bus = new C64RecoveryBus(space);
  assert.throws(() => bus.read(0x1000), /not been loaded/);
  assert.throws(() => bus.read(0xe544), /KERNAL/);
  bus.write(0xe544, 0xa9);
  assert.throws(() => bus.read(0xe544), /KERNAL/);
  assert.equal(bus.read(0xd030), 255);
  bus.write(0xd030, 0);
  assert.equal(bus.read(0xd030), 255);
  bus.write(1, 0x38);
  assert.equal(bus.read(0xe544), 0xa9);
  bus.write(0xd020, 0x42);
  assert.equal(bus.read(0xd020), 0x42);
  bus.write(1, 0x37);
  assert.equal(bus.read(0xd020), 0);
  assert.throws(() => bus.write(0xd400, 0), /No device write/);
  assert.throws(() => bus.peek(0xd020), /Executing instructions from I\/O/);
});
test('recovery reports the real access address and instruction PC for a missing service', () => {
  const space = new AddressSpace();
  space.loadPrg(Uint8Array.from([0, 0x80, 0x20, 0x44, 0xe5]));
  const bus = new C64RecoveryBus(space),
    machine = new Machine(bus);
  machine.pc = 0x8000;
  const result = recover(machine, {
    stopAt: 0x9000,
    maxInstructions: 10,
    maxVariants: 10,
    onFetch: (i) => bus.observe(i),
  });
  assert.equal(result.stop, 'gap');
  assert.equal(result.gap?.kind, 'firmware');
  assert.equal(result.gap?.address, 0xe544);
  assert.equal(result.gap?.pc, 0xe544);
  assert.equal(result.state.instructions, 1);
});
