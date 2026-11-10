import { ExecutionGap, type Machine } from '../../../../runtime/mos6502.js';
import type { C64SystemBus } from '../../../../systems/c64/system.js';

/** Release-specific packer knowledge. It stays with Elite, rather than making
 * unknown RAM readable in the common CPU or C64 bus. */
export class EliteStartup {
  discardedMarkerReads = 0;
  readonly inputs: { kind: string; pc: number }[] = [];
  constructor(readonly bus: C64SystemBus) {}
  boundary(machine: Machine): boolean {
    if (
      machine.pc === 0x376 &&
      !this.inputs.some((input) => input.kind === 'release-picture-space')
    ) {
      machine.guard(0x374, [0xa9, 0xff, 0xcd, 1, 0xdc, 0xf0, 0xfb]);
      this.bus.cia1.space = true;
      this.inputs.push({ kind: 'release-picture-space', pc: machine.pc });
    }
    if (machine.pc === 0x37b) {
      this.bus.cia1.space = false;
    }
    if (machine.pc === 0xf142) {
      const caller =
        ((machine.read(0x100 | ((machine.sp + 1) & 255)) |
          (machine.read(0x100 | ((machine.sp + 2) & 255)) << 8)) +
          1) &
        65535;
      let character = 0;
      if (
        caller >= 0x401b &&
        caller <= 0x413c &&
        this.bus.peek(caller) === 0xc9 &&
        this.bus.peek(caller + 1) === 0x4e &&
        this.bus.peek(caller + 2) === 0xf0 &&
        this.bus.peek(caller + 4) === 0xc9 &&
        this.bus.peek(caller + 5) === 0x59
      ) {
        character = 0x4e;
        this.inputs.push({ kind: 'trainer-no', pc: caller });
      }
      this.bus.kernal.characterInput = () => character;
    }
    if (
      machine.pc === 0x188 &&
      machine.word(0xfe) === 0x7ef &&
      machine.y === 0 &&
      !this.bus.known[0x7ef]
    ) {
      machine.guard(
        0x188,
        [
          0xb1, 0xfe, 0xa4, 0xfe, 0xd0, 2, 0xc6, 0xff, 0xc6, 0xfe, 0xc0, 0xef, 0xd0, 0x0e, 0xa4,
          0xff, 0xc0, 7, 0xd0, 8, 0xa9, 0x37, 0x85, 1, 0x58, 0x4c, 1, 8,
        ],
      );
      if (!(machine.p & 4)) {
        throw new ExecutionGap(
          'elite-packer',
          machine.pc,
          'The discarded marker read requires IRQs disabled.',
        );
      }
      // The last compressed-byte read is below the loaded PRG. The following
      // LDY replaces N/Z, pointer-only tests select the exit, and LDA #$37
      // replaces A before it is used. Its value cannot affect this exit path.
      // Preserve unknownness; do not invent a zero byte or patch original RAM.
      machine.pc = 0x18a;
      machine.cycles += 5;
      machine.instructions++;
      this.discardedMarkerReads++;
      return true;
    }
    return this.bus.boundary(machine);
  }
}
