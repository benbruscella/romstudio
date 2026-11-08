import type { Machine } from '../../../runtime/mos6502.js';
import type { C64Checkpoint } from '../../../systems/c64/snapshot.js';
import { C64Player } from '../../../systems/c64/player.js';
import { applyC64Controls, type C64Controls } from '../../../systems/c64/input.js';

/** Input is sampled at the original IRQ keyboard-state routine. The original
 * matrix scanner, menu, launch animation and flight code continue to execute. */
export class ElitePlayer extends C64Player<C64Controls> {
  constructor(
    checkpoint: C64Checkpoint,
    step: (machine: Machine) => void,
    input: (frame: number, player: ElitePlayer) => C64Controls,
    captureDisplay = true,
  ) {
    super(
      checkpoint,
      step,
      (frame) => input(frame, this),
      { controlAddress: 0xa90d, applyInput: applyC64Controls },
      captureDisplay,
    );
  }
}
