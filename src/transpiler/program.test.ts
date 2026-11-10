import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverStaticBranches,
  emitRecoveredProgram,
  importStaticProgram,
  knownMemoryInstructions,
} from './program.js';
import { AddressSpace } from '../memory.js';
import { C64SystemBus } from '../systems/c64/system.js';
import { captureC64 } from '../systems/c64/snapshot.js';
import { Machine, RamBus, ExecutionGap } from '../runtime/mos6502.js';

test('known-memory lifting covers an unobserved indirect target without guessing unknown opcode bytes', async () => {
  const space = new AddressSpace();
  space.bytes.set([0x6c, 0, 2], 0x8000);
  space.loaded.fill(1, 0x8000, 0x8003);
  space.bytes.set([0xa9, 42], 0x9000);
  space.loaded.fill(1, 0x9000, 0x9002);
  space.bytes.set([0, 0x90], 0x200);
  const memory = { ram: space.bytes, known: space.loaded };
  const cfg = recoverStaticBranches(memory, [0x8000], { start: 0x8000, end: 0x10000 });
  assert.ok(!cfg.instructions.some((instruction) => instruction.address === 0x9000));
  const envelope = knownMemoryInstructions(memory, { start: 0x8000, end: 0x10000 });
  assert.ok(envelope.some((instruction) => instruction.address === 0x9000));
  assert.ok(!envelope.some((instruction) => instruction.address === 0xa000));
  const { step } = await importStaticProgram(emitRecoveredProgram([], {}, envelope));
  const machine = new Machine(new RamBus(space.bytes));
  machine.pc = 0x8000;
  step(machine);
  step(machine);
  assert.equal(machine.a, 42);
});

test('an unknown operand remains an unknown bus read after opcode-shape lifting', async () => {
  const space = new AddressSpace();
  space.bytes[0x9000] = 0xa9;
  space.loaded[0x9000] = 1;
  const memory = { ram: space.bytes, known: space.loaded };
  const instructions = knownMemoryInstructions(memory, { start: 0x9000, end: 0x9002 });
  assert.match(instructions[0]!.text, /operand read from memory/);
  const { step } = await importStaticProgram(emitRecoveredProgram([], {}, instructions));
  const bus = new C64SystemBus(space);
  const machine = new Machine(bus);
  machine.pc = 0x9000;
  assert.throws(
    () => step(machine),
    (error) => error instanceof ExecutionGap && error.address === 0x9001,
  );
  assert.equal(bus.known[0x9001], 0);
});

test('static branch recovery includes untaken paths from known code and retains explicit unknown/outside/indirect gaps', async () => {
  const space = new AddressSpace();
  space.bytes.set([0xf0, 4, 0xa9, 42, 0x60, 0xea, 0xa2, 99, 0x60], 0x8000);
  space.loaded.fill(1, 0x8000, 0x8009);
  const bus = new C64SystemBus(space),
    machine = new Machine(bus),
    checkpoint = captureC64(bus, machine);
  const cfg = recoverStaticBranches(checkpoint, [0x8000], { start: 0x8000, end: 0x8100 });
  assert.ok(cfg.instructions.some((instruction) => instruction.address === 0x8002));
  assert.ok(cfg.instructions.some((instruction) => instruction.address === 0x8006));
  const { step } = await importStaticProgram(emitRecoveredProgram([], {}, cfg.instructions));
  const program = new Machine(new RamBus(space.bytes));
  program.pc = 0x8000;
  program.p = 0x20;
  step(program);
  step(program);
  assert.equal(program.a, 42);
  program.pc = 0x8000;
  program.p = 0x22;
  step(program);
  step(program);
  assert.equal(program.x, 99);
  checkpoint.known[0x8007] = 0;
  assert.ok(
    recoverStaticBranches(checkpoint, [0x8006], { start: 0x8000, end: 0x8100 }).unresolved.some(
      (gap) => gap.kind === 'truncated',
    ),
  );
  assert.equal(
    recoverStaticBranches(checkpoint, [0x8000], { start: 0x8100, end: 0x8200 }).instructions.length,
    0,
  );
  checkpoint.ram.splice(0x8000, 3, 0x6c, 0, 0x90);
  checkpoint.known[0x8007] = 1;
  const indirect = recoverStaticBranches(checkpoint, [0x8000], { start: 0x8000, end: 0x8100 });
  assert.equal(indirect.instructions.length, 1);
  assert.ok(indirect.unresolved.some((gap) => gap.kind === 'indirect'));
});
