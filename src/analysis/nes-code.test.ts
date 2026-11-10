import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nesProgramInstructions } from './nes-code.js';
import { emitRecoveredProgram, importStaticProgram } from '../transpiler/program.js';
import { NesSystemBus, type NesLaunch } from '../systems/nes/system.js';
import { Machine } from '../runtime/mos6502.js';

test('static PRG coverage follows both MMC1 windows even when no route visited the bank', async () => {
  const prg = new Uint8Array(32768);
  prg.fill(2); // Unsupported byte values are data, not claimed instruction starts.
  prg.set([0xa9, 42], 0);
  prg.set([0xa2, 99], 16384);
  const launch: NesLaunch = {
    version: 1,
    system: 'nes',
    timing: 'pal-2a07',
    ramFill: 0,
    cartridge: { mapper: 1, mirroring: 'vertical', prg, chr: new Uint8Array(8192) },
  };
  const instructions = nesProgramInstructions(launch);
  for (const address of [0x8000, 0xc000]) {
    assert.ok(instructions.some((item) => item.address === address && item.opcode === 0xa9));
    assert.ok(instructions.some((item) => item.address === address && item.opcode === 0xa2));
  }
  const { step } = await importStaticProgram(emitRecoveredProgram([], {}, instructions));
  const bus = new NesSystemBus(launch),
    machine = new Machine(bus);
  bus.cartridge.registers.control = 0x0c;
  machine.pc = 0x8000;
  step(machine);
  assert.equal(machine.a, 42);
  bus.cartridge.registers.prg = 1;
  machine.pc = 0x8000;
  step(machine);
  assert.equal(machine.x, 99);
  bus.cartridge.registers.control = 0x08;
  bus.cartridge.registers.prg = 0;
  machine.pc = 0xc000;
  step(machine);
  assert.equal(machine.a, 42);
});
