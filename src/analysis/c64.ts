import type { C64Player } from '../systems/c64/player.js';
import { captureC64 } from '../systems/c64/snapshot.js';
import { sha256, Diagnostic } from '../core.js';

/** Node-side C64 evidence. This file is never copied into browser packages. */
export function fingerprintPlayer<Input, Result>(player: C64Player<Input, Result>) {
  return {
    state: sha256(JSON.stringify(captureC64(player.bus, player.machine))),
    display: sha256(player.display.pixels),
    inputs: sha256(JSON.stringify(player.inputs)),
  };
}
export function replayToControls<Input, Result>(
  player: C64Player<Input, Result>,
  frames: number,
  maxOperations = 15000000,
): void {
  let operations = 0;
  while (player.controlFrames < frames) {
    if (++operations > maxOperations) {
      throw new Diagnostic(
        'STATIC_REPLAY_BUDGET',
        'Static input replay exceeded its operation budget.',
      );
    }
    if (!player.boundary()) {
      player.step(player.machine);
    }
  }
}
