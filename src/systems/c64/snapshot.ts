import { Diagnostic } from '../../contracts.js';
import { Machine, type CpuState } from '../../runtime/mos6502.js';
import { AddressSpace } from '../../memory.js';
import { C64SystemBus } from './system.js';
import type { Cia6526 } from './cia.js';

interface TimerState {
  latch: number;
  counter: number;
  control: number;
}
interface CiaState {
  registers: number[];
  a: TimerState;
  b: TimerState;
  pending: number;
  mask: number;
  inputA: number;
  inputB: number;
  space: boolean;
  pressedKeys: number[];
}
export interface C64Checkpoint {
  version: 1;
  ram: number[];
  known: number[];
  cpu: CpuState;
  clock: number;
  vic: {
    registers: number[];
    cycles: number;
    rasterCompare: number;
    irqFlags: number;
    irqMask: number;
  };
  cia1: CiaState;
  cia2: CiaState;
  colour: number[];
  sid: number[];
  sidBusValue: number;
  sidWriteCount: number;
  irqEntries: number;
  defaultIrqCalls: number;
}
function captureCia(cia: Cia6526): CiaState {
  const timer = ({ latch, counter, control }: TimerState): TimerState => ({
    latch,
    counter,
    control,
  });
  return {
    registers: [...cia.registers],
    a: timer(cia.a),
    b: timer(cia.b),
    pending: cia.pending,
    mask: cia.mask,
    inputA: cia.inputA,
    inputB: cia.inputB,
    space: cia.space,
    pressedKeys: [...cia.pressedKeys],
  };
}
/** A running game needs device latches and clocks as well as RAM. Analysis-only
 * provenance/caches are excluded; original memory values and knownness remain. */
export function captureC64(bus: C64SystemBus, machine: Machine): C64Checkpoint {
  const { cycles, rasterCompare, irqFlags, irqMask } = bus.vic;
  return {
    version: 1,
    ram: [...bus.bytes],
    known: [...bus.known],
    cpu: machine.snapshot(),
    clock: bus.clock,
    vic: { registers: [...bus.vic.registers], cycles, rasterCompare, irqFlags, irqMask },
    cia1: captureCia(bus.cia1),
    cia2: captureCia(bus.cia2),
    colour: [...bus.colour],
    sid: [...bus.sid],
    sidBusValue: bus.sidBusValue,
    sidWriteCount: bus.sidWriteCount,
    irqEntries: bus.irqEntries,
    defaultIrqCalls: bus.defaultIrqCalls,
  };
}
export function restoreC64(checkpoint: C64Checkpoint) {
  const fail = (): never => {
    throw new Diagnostic('C64_CHECKPOINT', 'Invalid C64 checkpoint.');
  };
  const number = (value: number, max: number): void => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      fail();
    }
  };
  const bytes = (values: number[], length: number, max = 255): void => {
    if (!Array.isArray(values) || values.length !== length) {
      fail();
    }
    for (const value of values) {
      number(value, max);
    }
  };
  if (
    !checkpoint ||
    checkpoint.version !== 1 ||
    !checkpoint.cpu ||
    !checkpoint.vic ||
    !checkpoint.cia1 ||
    !checkpoint.cia2
  ) {
    fail();
  }
  bytes(checkpoint.ram, 65536);
  bytes(checkpoint.known, 65536, 1);
  bytes(checkpoint.colour, 1024, 15);
  bytes(checkpoint.sid, 32);
  for (const field of ['a', 'x', 'y', 'sp', 'p'] as const) {
    number(checkpoint.cpu[field], 255);
  }
  number(checkpoint.cpu.pc, 65535);
  for (const value of [
    checkpoint.cpu.cycles,
    checkpoint.cpu.instructions,
    checkpoint.clock,
    checkpoint.sidWriteCount,
    checkpoint.irqEntries,
    checkpoint.defaultIrqCalls,
  ]) {
    number(value, Number.MAX_SAFE_INTEGER);
  }
  number(checkpoint.sidBusValue, 255);
  if (checkpoint.clock > checkpoint.cpu.cycles || checkpoint.vic.cycles !== checkpoint.clock) {
    fail();
  }
  bytes(checkpoint.vic.registers, 64);
  number(checkpoint.vic.rasterCompare, 511);
  number(checkpoint.vic.irqFlags, 15);
  number(checkpoint.vic.irqMask, 15);
  for (const cia of [checkpoint.cia1, checkpoint.cia2]) {
    bytes(cia.registers, 16);
    number(cia.pending, 31);
    number(cia.mask, 31);
    number(cia.inputA, 255);
    number(cia.inputB, 255);
    if (
      typeof cia.space !== 'boolean' ||
      !Array.isArray(cia.pressedKeys) ||
      cia.pressedKeys.length > 64
    ) {
      fail();
    }
    for (const key of cia.pressedKeys) {
      number(key, 63);
    }
    for (const timer of [cia.a, cia.b]) {
      if (!timer) {
        fail();
      }
      number(timer.latch, 65535);
      number(timer.counter, 65535);
      number(timer.control, 255);
    }
  }
  const space = new AddressSpace();
  space.bytes.set(checkpoint.ram);
  space.loaded.set(checkpoint.known);
  const bus = new C64SystemBus(space);
  // The constructor supplies launch defaults. A resume must restore the actual
  // processor-port bytes, not accidentally select ROM again.
  bus.bytes.set(checkpoint.ram);
  bus.known.set(checkpoint.known);
  const machine = new Machine(bus);
  Object.assign(machine, checkpoint.cpu);
  Object.assign(bus.vic, {
    cycles: checkpoint.vic.cycles,
    rasterCompare: checkpoint.vic.rasterCompare,
    irqFlags: checkpoint.vic.irqFlags,
    irqMask: checkpoint.vic.irqMask,
  });
  bus.vic.registers.set(checkpoint.vic.registers);
  for (const [cia, data] of [
    [bus.cia1, checkpoint.cia1],
    [bus.cia2, checkpoint.cia2],
  ] as const) {
    cia.registers.set(data.registers);
    Object.assign(cia.a, data.a);
    Object.assign(cia.b, data.b);
    cia.pending = data.pending;
    cia.mask = data.mask;
    cia.inputA = data.inputA;
    cia.inputB = data.inputB;
    cia.space = data.space;
    for (const key of data.pressedKeys) {
      cia.pressedKeys.add(key);
    }
  }
  bus.colour.set(checkpoint.colour);
  bus.sid.set(checkpoint.sid);
  for (const field of [
    'clock',
    'sidBusValue',
    'sidWriteCount',
    'irqEntries',
    'defaultIrqCalls',
  ] as const) {
    bus[field] = checkpoint[field];
  }
  return { bus, machine };
}
