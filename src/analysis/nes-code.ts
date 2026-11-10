import type { Instruction } from '../transpiler/mos6502.js';
import { knownMemoryInstructions } from '../transpiler/program.js';
import { NesSystemBus, type NesLaunch } from '../systems/nes/system.js';

/** Enumerate the immutable PRG bytes that can appear at each CPU address.
 * MMC1 can select a 16 KiB bank in either window. Operands are read from the
 * actual mapper at execution, including instructions crossing window edges. */
export function nesProgramInstructions(launch: NesLaunch): Instruction[] {
  const bus = new NesSystemBus(launch);
  if (launch.cartridge.mapper === 0) {
    return knownMemoryInstructions(bus.memoryImage(), { start: 0x8000, end: 0x10000 });
  }
  const instructions: Instruction[] = [];
  for (let bank = 0; bank < bus.cartridge.prg.length / 16384; bank++) {
    bus.cartridge.registers.prg = bank;
    bus.cartridge.registers.control = 0x0c;
    instructions.push(
      ...knownMemoryInstructions(bus.memoryImage(), { start: 0x8000, end: 0xc000 }),
    );
    bus.cartridge.registers.control = 0x08;
    instructions.push(
      ...knownMemoryInstructions(bus.memoryImage(), { start: 0xc000, end: 0x10000 }),
    );
  }
  return instructions;
}
