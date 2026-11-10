import type { Machine } from '../../runtime/mos6502.js';
import type { RecoveryGap } from '../../runtime/frame.js';
import type { DeskRun, DeskState, DeskStepKind, DeskTarget } from './types.js';

/** What the C64 and NES players expose to ROM Desk. */
export interface Mos6502DeskHost {
  readonly machine: Machine;
  readonly gap: RecoveryGap | undefined;
  readonly outcome?: unknown;
  readonly clock: { frames: number };
  readonly controlFrames: number;
  runFrame(stop?: (machine: Machine) => boolean): boolean;
  peek(address: number): number | undefined;
  identity(address: number): string;
}

const hex = (value: number, width = 2) => value.toString(16).toUpperCase().padStart(width, '0');
const flagNames = [
  ['N', 128, 'Negative'],
  ['V', 64, 'Overflow'],
  ['B', 16, 'Break (only meaningful in a pushed copy of P)'],
  ['D', 8, 'Decimal mode'],
  ['I', 4, 'Interrupt disable'],
  ['Z', 2, 'Zero'],
  ['C', 1, 'Carry'],
] as const;

export function mos6502State(host: Mos6502DeskHost, tier: string, last?: string): DeskState {
  const m = host.machine;
  const bytes: number[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const value = host.peek((m.pc + offset) & 0xffff);
    if (value === undefined) {
      break;
    }
    bytes.push(value);
  }
  return {
    processors: [
      {
        id: 'cpu',
        label: '6502 CPU',
        pc: m.pc,
        bytes,
        opcode: bytes[0],
        identity: host.identity(m.pc),
        registers: [
          { name: 'PC', value: '$' + hex(m.pc, 4) },
          { name: 'A', value: '$' + hex(m.a) },
          { name: 'X', value: '$' + hex(m.x) },
          { name: 'Y', value: '$' + hex(m.y) },
          { name: 'SP', value: '$' + hex(m.sp), title: `Stack at $01${hex(m.sp)}` },
          { name: 'P', value: '$' + hex(m.p) },
        ],
        flags: flagNames.map(([name, mask, title]) => ({ name, set: !!(m.p & mask), title })),
        sourceDirectory: 'game-code/',
      },
    ],
    counters: [
      { name: 'CPU cycles', value: m.cycles.toLocaleString() },
      { name: 'Instructions', value: m.instructions.toLocaleString() },
      { name: 'Frames', value: host.clock.frames.toLocaleString() },
      { name: 'Input polls', value: host.controlFrames.toLocaleString() },
    ],
    frame: host.clock.frames,
    tier,
    ...(last ? { last } : {}),
    ...(host.gap ? { gap: `${host.gap.kind} at $${hex(host.gap.pc, 4)}: ${host.gap.detail}` } : {}),
  };
}

/** C64/NES Desk: the page's own player, paused between animation frames, is
 * driven one frame-clock operation at a time. `pause`/`resume` stop and
 * restart the page's ordinary frame loop; `restart` recreates the player. */
export function mos6502Desk(options: {
  system: 'c64' | 'nes';
  host: () => Mos6502DeskHost | undefined;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  picture: () => void;
}): DeskTarget {
  const tier = 'reference (the only tier for this system)';
  let interrupted = false;
  const host = () => {
    const value = options.host();
    if (!value) {
      throw new Error('The game has not started.');
    }
    return value;
  };
  const describe = (before: { pc: number; instructions: number; cycles: number }) => {
    const m = host().machine;
    if (m.instructions !== before.instructions) {
      return `Executed the instruction at $${hex(before.pc, 4)} (${m.cycles - before.cycles} cycles).`;
    }
    if (m.pc !== before.pc) {
      return `Boundary service at $${hex(before.pc, 4)}: execution continues at $${hex(m.pc, 4)} (${m.cycles - before.cycles} cycles).`;
    }
    return `Boundary service at $${hex(before.pc, 4)} (${m.cycles - before.cycles} cycles).`;
  };
  const target: DeskTarget = {
    system: options.system,
    steps: [
      {
        kind: 'instruction',
        label: 'Step',
        title: 'Run one boundary service or translated instruction',
      },
      { kind: 'frame', label: 'Frame', title: 'Run to the end of the current frame' },
    ],
    memory: [{ id: 'cpu', label: 'CPU address space', start: 0, size: 65536 }],
    async open() {
      options.pause();
      return mos6502State(host(), tier, 'Paused at a frame boundary.');
    },
    async close() {
      interrupted = true;
      options.resume();
    },
    async state() {
      return mos6502State(host(), tier);
    },
    async step(kind: DeskStepKind) {
      const h = host(),
        m = h.machine,
        before = { pc: m.pc, instructions: m.instructions, cycles: m.cycles };
      if (h.gap || h.outcome) {
        return mos6502State(h, tier, 'Execution has ended; restart to continue.');
      }
      let last: string;
      if (kind === 'frame') {
        h.runFrame();
        last = `Ran to the end of frame ${h.clock.frames} (${(m.cycles - before.cycles).toLocaleString()} cycles).`;
      } else {
        let asked = false;
        const completed = h.runFrame(() => {
          const stop = asked;
          asked = true;
          return stop;
        });
        last = describe(before) + (completed ? ' The frame completed.' : '');
      }
      options.picture();
      return mos6502State(h, tier, last);
    },
    async run(request: DeskRun) {
      const h = host(),
        breakpoints = new Set(request.breakpoints);
      interrupted = false;
      let first = true;
      for (let frame = 0; frame < request.frames; frame++) {
        const completed = h.runFrame((m) => {
          if (first) {
            first = false;
            return false;
          }
          return breakpoints.has(m.pc);
        });
        options.picture();
        if (h.gap || h.outcome) {
          return { ...mos6502State(h, tier, 'Execution ended.'), stopped: 'gap' as const };
        }
        if (!completed) {
          return {
            ...mos6502State(h, tier, `Breakpoint at $${hex(h.machine.pc, 4)}.`),
            stopped: 'breakpoint' as const,
          };
        }
        // Let the page draw and the Pause button work between frames.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (interrupted) {
          break;
        }
      }
      return { ...mos6502State(h, tier, 'Paused after running.'), stopped: 'frames' as const };
    },
    interrupt() {
      interrupted = true;
    },
    async read(_space: string, address: number, length: number) {
      const h = host();
      return Array.from({ length }, (_, offset) => h.peek((address + offset) & 0xffff));
    },
    async restart() {
      options.restart();
      options.pause();
      return mos6502State(host(), tier, 'Restarted from the launch checkpoint, paused.');
    },
  };
  return target;
}
