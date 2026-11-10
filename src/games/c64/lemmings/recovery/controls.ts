import { readLemming } from '../code/digger.js';
import type { GameInput } from '../player.js';
import type { C64SystemBus } from '../../../../systems/c64/system.js';

// Hold each direction long enough to reach its limit despite acceleration and
// direction reversal. The original 50-frame vertical legs missed the bottom.
const cursorLegs = [
  { joystick: 247, frames: 350 },
  { joystick: 251, frames: 350 },
  { joystick: 254, frames: 100 },
  { joystick: 253, frames: 100 },
  { joystick: 250, frames: 100 },
  { joystick: 245, frames: 100 },
  { joystick: 249, frames: 100 },
  { joystick: 246, frames: 100 },
  { joystick: 255, frames: 8 },
] as const;
export const CURSOR_COVERAGE_FRAMES = cursorLegs.reduce((sum, leg) => sum + leg.frames, 0);
export function cursorCoverageControls(selectDigger: boolean) {
  return (frame: number): Omit<GameInput, 'frame'> => {
    let remaining = frame;
    for (const leg of cursorLegs) {
      if (remaining <= leg.frames) {
        return { joystick: leg.joystick, key8: selectDigger && frame === 1, deleteKey: false };
      }
      remaining -= leg.frames;
    }
    return { joystick: 255, key8: false, deleteKey: false };
  };
}

/** Reproducible original-input route: one digger makes a passage, six reach
 * the exit, then the original double-Delete action ends two trapped entities.
 * No entity positions, stock, terrain or completion counters are changed here. */
export function firstLevelControls() {
  let sentFire = false;
  return (frame: number, bus: C64SystemBus): Omit<GameInput, 'frame'> => {
    let joystick = 255;
    if (!sentFire) {
      const actor = readLemming(bus, 0),
        cursorX = bus.bytes[0xb6]!,
        cursorY = bus.bytes[0xb8]!;
      const scroll = (bus.bytes[0x40d]! << 2) | (bus.bytes[0x40c]! >>> 1);
      const targetX = actor.x - 1 - scroll,
        targetY = actor.y + 6;
      if (targetX > cursorX + 1) {
        joystick &= ~8;
      } else if (targetX < cursorX - 1) {
        joystick &= ~4;
      }
      if (targetY > cursorY + 1) {
        joystick &= ~2;
      } else if (targetY < cursorY - 1) {
        joystick &= ~1;
      }
      if (
        bus.bytes[0x5c1] === 0 &&
        (actor.mode & 31) === 8 &&
        Math.abs(targetX - cursorX) <= 3 &&
        Math.abs(targetY - cursorY) <= 4
      ) {
        joystick &= ~16;
        sentFire = true;
      }
    }
    return {
      joystick,
      key8: !sentFire && bus.bytes[0x5c0] !== 7,
      deleteKey: frame === 3500 || frame === 3502,
    };
  };
}
