import type { N64Player } from '../player.js';
import type { DeskState, DeskValue } from '../../../web/desk/types.js';

/** ROM Desk inside the N64 machine worker (docs/DESK.md). Reads are
 * side-effect free: RDRAM and RSP memories are read directly, never through
 * device registers. */
const names = [
  'zero',
  'at',
  'v0',
  'v1',
  'a0',
  'a1',
  'a2',
  'a3',
  't0',
  't1',
  't2',
  't3',
  't4',
  't5',
  't6',
  't7',
  's0',
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  't8',
  't9',
  'k0',
  'k1',
  'gp',
  'sp',
  's8',
  'ra',
];
const hex = (value: number, width: number) =>
  (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
const wide = (value: bigint) =>
  BigInt.asUintN(64, value).toString(16).toUpperCase().padStart(16, '0');

/** Physical RDRAM offset of a KSEG0/KSEG1 address (or a physical one). */
export function rdramOffset(address: number, size: number): number | undefined {
  const value = address >>> 0;
  const physical = value >= 0x80000000 && value < 0xc0000000 ? value & 0x1fffffff : value;
  return physical < size ? physical : undefined;
}

export function n64DeskRead(
  player: N64Player,
  space: string,
  address: number,
  length: number,
): (number | undefined)[] {
  const ram = player.system.memory.ram.bytes,
    signal = player.system.memory.signal.memory;
  return Array.from({ length: Math.min(length, 4096) }, (_, offset) => {
    const at = (address + offset) >>> 0;
    if (space === 'dmem') {
      return at < 0x1000 ? signal[at] : undefined;
    }
    if (space === 'imem') {
      return at < 0x1000 ? signal[0x1000 + at] : undefined;
    }
    const physical = rdramOffset(at, ram.length);
    return physical === undefined ? undefined : ram[physical];
  });
}

export function n64DeskState(player: N64Player, tier: string, last?: string): DeskState {
  const s = player.system,
    cpu = s.cpu,
    rsp = s.rsp,
    ram = s.memory.ram.bytes,
    signal = s.memory.signal;
  const pc = cpu.pc >>> 0,
    physical = rdramOffset(pc, ram.length);
  const cpuBytes =
    physical === undefined || physical + 4 > ram.length
      ? []
      : [...ram.slice(physical, physical + 4)];
  const word = (bytes: number[]) =>
    bytes.length === 4
      ? ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
      : undefined;
  const control = (index: number) => {
    try {
      return '$' + hex(cpu.control.read(index), 8);
    } catch {
      return '—';
    }
  };
  const cpuRegisters: DeskValue[] = [
    { name: 'PC', value: '$' + hex(pc, 8) },
    ...names.map((name, index) => ({
      name,
      value: wide(cpu.registers[index]!),
      title: `r${index} = ${cpu.registers[index]!.toString()}`,
    })),
    { name: 'HI', value: wide(cpu.hi) },
    { name: 'LO', value: wide(cpu.lo) },
    { name: 'Status', value: control(12), title: 'COP0 register 12' },
    { name: 'Cause', value: control(13), title: 'COP0 register 13' },
    { name: 'EPC', value: control(14), title: 'COP0 register 14' },
    { name: 'Count', value: control(9), title: 'COP0 register 9' },
    { name: 'Compare', value: control(11), title: 'COP0 register 11' },
  ];
  const rspPc = signal.pc & 0xffc,
    rspBytes = [...signal.memory.slice(0x1000 + rspPc, 0x1000 + rspPc + 4)],
    halted = (signal.status & 1) !== 0;
  const region =
    pc >= 0x80000000 && pc < 0xa0000000
      ? 'KSEG0 (cached)'
      : pc >= 0xa0000000 && pc < 0xc0000000
        ? 'KSEG1 (uncached)'
        : 'mapped (TLB)';
  return {
    processors: [
      {
        id: 'cpu',
        label: 'VR4300 CPU',
        pc,
        bytes: cpuBytes,
        opcode: word(cpuBytes),
        identity:
          physical === undefined
            ? `${region} · not in RDRAM`
            : `${region} · RDRAM $${hex(physical, 6)}${cpu.inBranchDelaySlot ? ' · branch delay slot' : ''}`,
        registers: cpuRegisters,
        sourceDirectory: 'game-code/',
      },
      {
        id: 'rsp',
        label: 'RSP (signal processor)',
        pc: rspPc,
        bytes: rspBytes,
        opcode: word(rspBytes),
        identity: `IMEM offset $${hex(rspPc, 3)} (RSP address space, separate from the CPU)`,
        registers: Array.from({ length: 32 }, (_, index) => ({
          name: `r${index}`,
          value: '$' + hex(rsp.registers[index]!, 8),
        })),
        ...(halted ? { note: 'Halted: the RSP runs only while the CPU has started a task.' } : {}),
        sourceDirectory: 'game-code/rsp-play/',
      },
    ],
    counters: [
      { name: 'Machine ticks', value: s.ticks.toLocaleString() },
      { name: 'CPU instructions', value: cpu.instructions.toLocaleString() },
      { name: 'RSP instructions', value: rsp.instructions.toLocaleString() },
      { name: 'Frames (FullSync)', value: s.memory.display.fullSyncs.toLocaleString() },
      { name: 'Controller polls', value: player.controls.polls.toLocaleString() },
    ],
    frame: s.memory.display.fullSyncs,
    tier,
    ...(last ? { last } : {}),
    ...(player.gap
      ? { gap: `${player.gap.kind} at $${hex(player.gap.pc, 8)}: ${player.gap.detail}` }
      : {}),
  };
}

/** Describe one tick for the Desk status line. */
export function describeTick(
  before: { cpu: number; rsp: number },
  retired: { cpu: boolean; rsp: boolean; interrupt?: boolean; exception?: boolean },
): string {
  const parts = [];
  if (retired.interrupt) {
    parts.push(
      `Interrupt taken at $${hex(before.cpu, 8)}: the CPU entered the exception vector and ran its first instruction`,
    );
  } else if (retired.exception) {
    parts.push(`The instruction at $${hex(before.cpu, 8)} raised an exception`);
  } else if (retired.cpu) {
    parts.push(`CPU executed $${hex(before.cpu, 8)}`);
  }
  if (retired.rsp) {
    parts.push(`RSP executed IMEM $${hex(before.rsp, 3)}`);
  }
  return parts.length ? parts.join('; ') + '.' : 'Devices advanced one tick.';
}
