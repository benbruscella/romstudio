import type { Machine } from '../../../runtime/mos6502.js';
import type { C64Checkpoint } from '../../../systems/c64/snapshot.js';
import { C64Player } from '../../../systems/c64/player.js';
import { applyC64Controls } from '../../../systems/c64/input.js';
import { decodeLevelHeader } from './code/level-data.js';
import { readSkillStock } from './code/digger.js';

export interface GameInput {
  frame: number;
  joystick: number;
  key8: boolean;
  deleteKey: boolean;
}
export interface LevelResult {
  won: boolean;
  rescued: number;
  total: number;
  percent: number;
  required: number;
  reason: number;
}
export function levelResult(machine: Machine): LevelResult | undefined {
  if (machine.pc !== 0xe7c || !(machine.bus.read(0x588) & 128)) {
    return;
  }
  const rescued = machine.bus.read(0xcb45),
    total = machine.bus.read(0xe039),
    reason = machine.bus.read(0xcb46);
  const required = Number(String.fromCharCode(machine.bus.read(0xe03a), machine.bus.read(0xe03b)));
  const percent = total ? (rescued * 100) / total : 0;
  return { won: reason === 9 && percent >= required, rescued, total, percent, required, reason };
}

/** Lemmings-specific state and input mapping over the common C64 player. */
export class LemmingsPlayer extends C64Player<Omit<GameInput, 'frame'>, LevelResult> {
  readonly header;
  constructor(
    checkpoint: C64Checkpoint,
    step: (machine: Machine) => void,
    input: (frame: number, player: LemmingsPlayer) => Omit<GameInput, 'frame'>,
    captureDisplay = true,
  ) {
    super(
      checkpoint,
      step,
      (frame) => input(frame, this),
      {
        controlAddress: 0x16d3,
        logicAddress: 0xe39,
        result: levelResult,
        applyInput: (bus, next) =>
          applyC64Controls(bus, {
            joystick: next.joystick,
            keys: [...(next.key8 ? [27] : []), ...(next.deleteKey ? [0] : [])],
          }),
      },
      captureDisplay,
    );
    this.header = decodeLevelHeader(this.bus);
  }
  stats() {
    const read = (address: number): number => this.bus.bytes[address]!;
    return {
      rescued: read(0xcb45),
      total: this.header.lemmingCount,
      released: read(0x5b7),
      alive: read(0xcb3e) * 10 + read(0xcb3f),
      stock: readSkillStock(this.bus, 7),
      seconds: read(0xcb39) * 60 + read(0xcb3a) * 10 + read(0xcb3b),
    };
  }
}

export function replayControls(events: readonly GameInput[]) {
  let index = 0;
  let state: Omit<GameInput, 'frame'> = { joystick: 255, key8: false, deleteKey: false };
  return (frame: number): Omit<GameInput, 'frame'> => {
    if (events[index]?.frame === frame) {
      const event = events[index++]!;
      state = { joystick: event.joystick, key8: event.key8, deleteKey: event.deleteKey };
    }
    return state;
  };
}
