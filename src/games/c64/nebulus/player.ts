import type { Machine } from '../../../runtime/mos6502.js';
import type { C64Checkpoint } from '../../../systems/c64/snapshot.js';
import { C64Player } from '../../../systems/c64/player.js';
import { applyC64Controls, type C64Controls } from '../../../systems/c64/input.js';

const decimal = (value: number): number => (value >>> 4) * 10 + (value & 15);
/** Original $AB91 joystick reads and $80AB first-tower updates. All movement,
 * drawing, timer arithmetic and collisions execute translated instructions. */
export class NebulusPlayer extends C64Player<C64Controls> {
  private inMenu: boolean;
  constructor(
    checkpoint: C64Checkpoint,
    step: (machine: Machine) => void,
    input: (frame: number, player: NebulusPlayer) => C64Controls,
    captureDisplay = true,
  ) {
    super(
      checkpoint,
      step,
      (frame) => input(frame, this),
      {
        controlAddress: 0xab91,
        logicAddress: 0x80ab,
        applyInput: applyC64Controls,
      },
      captureDisplay,
    );
    // The menu call at $8049 leaves return address $804B on the live stack.
    // $8015 is a two-tick input-suppression counter, not a menu/game flag.
    this.inMenu = checkpoint.cpu.pc === 0x89cf;
    for (let at = 0x101 + checkpoint.cpu.sp; at < 0x1ff; at++) {
      if (checkpoint.ram[at] === 0x4b && checkpoint.ram[at + 1] === 0x80) {
        this.inMenu = true;
      }
    }
  }
  override boundary(): boolean {
    if (this.machine.pc === 0x89cf) {
      this.inMenu = true;
    }
    if (this.machine.pc === 0x804c) {
      this.inMenu = false;
    }
    return super.boundary();
  }
  /** Observe entry/return of the original menu routine; no game-state writes. */
  get waitingToStart(): boolean {
    return this.inMenu;
  }
  stats() {
    const ram = this.bus.bytes;
    return {
      tower: ram[0x4a]! + 1,
      lives: decimal(ram[0x52]!),
      time: decimal(ram[0x65]!) * 100 + decimal(ram[0x64]!),
      viewRow: ram[0x46]!,
      rotation: ram[0x47]!,
    };
  }
}
