import { ExecutionGap } from '../../runtime/mos6502.js';
import type { C64SystemBus } from './system.js';
import type { BrowserControls } from '../../runtime/controls.js';

/** Host key names become active-low C64 pins only at this system boundary. */
export function c64ControlsFromBrowser(input: BrowserControls): C64Controls {
  const pressed = new Set(input.pressed);
  let joystick = 255;
  for (const [code, bit] of [
    ['ArrowUp', 1],
    ['ArrowDown', 2],
    ['ArrowLeft', 4],
    ['ArrowRight', 8],
    ['Space', 16],
  ] as const) {
    if (pressed.has(code)) {
      joystick &= ~bit;
    }
  }
  return {
    joystick,
    keys: [...(pressed.has('Digit8') ? [27] : []), ...(pressed.has('Delete') ? [0] : [])],
  };
}
export interface C64Controls {
  joystick: number;
  keys: number[];
}
export interface RecordedControls extends C64Controls {
  frame: number;
}
export const idleControls = (): C64Controls => ({ joystick: 255, keys: [] });
/** Digital joystick pins and closed keyboard-matrix switches, independent of a
 * title's meaning for fire, skill shortcuts or menu keys. */
export function applyC64Controls(bus: C64SystemBus, input: C64Controls, port: 1 | 2 = 2): void {
  if (
    !Number.isInteger(input.joystick) ||
    input.joystick < 0 ||
    input.joystick > 255 ||
    input.keys.length > 64 ||
    input.keys.some((key) => !Number.isInteger(key) || key < 0 || key > 63)
  ) {
    throw new ExecutionGap(
      'input-profile',
      0xdc00,
      'Invalid C64 controller pins or keyboard switches.',
    );
  }
  if (port === 2) {
    bus.cia1.inputA = input.joystick;
  } else {
    bus.cia1.inputB = input.joystick;
  }
  bus.cia1.pressedKeys.clear();
  for (const key of input.keys) {
    bus.cia1.setKey(key >>> 3, key & 7, true);
  }
}
export function replayC64Controls(events: readonly RecordedControls[]) {
  let index = 0,
    current = idleControls();
  return (frame: number): C64Controls => {
    while (index < events.length && events[index]!.frame <= frame) {
      const event = events[index++]!;
      current = { joystick: event.joystick, keys: event.keys };
    }
    return current;
  };
}
