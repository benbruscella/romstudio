import { Diagnostic, hex } from '../core.js';
import { type AddressSpace, type LocationSource } from '../memory.js';

export type Mode =
  | 'imp'
  | 'acc'
  | 'imm'
  | 'zp'
  | 'zpx'
  | 'zpy'
  | 'abs'
  | 'abx'
  | 'aby'
  | 'ind'
  | 'izx'
  | 'izy'
  | 'rel';
export interface Opcode {
  opcode: number;
  mnemonic: string;
  mode: Mode;
  size: number;
  cycles: number;
  pagePenalty: boolean;
}
export interface Instruction extends Opcode {
  address: number;
  bytes: number[];
  operand: number;
  text: string;
  source?: LocationSource;
}
const widths: Record<Mode, number> = {
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpx: 2,
  zpy: 2,
  abs: 3,
  abx: 3,
  aby: 3,
  ind: 3,
  izx: 2,
  izy: 2,
  rel: 2,
};
// NMOS 6502/6510 documented opcodes. CMOS and undocumented opcodes deliberately fail.
const definitions = `
00 BRK imp 7;01 ORA izx 6;05 ORA zp 3;06 ASL zp 5;08 PHP imp 3;09 ORA imm 2;0A ASL acc 2;0D ORA abs 4;0E ASL abs 6;
10 BPL rel 2;11 ORA izy 5+;15 ORA zpx 4;16 ASL zpx 6;18 CLC imp 2;19 ORA aby 4+;1D ORA abx 4+;1E ASL abx 7;
20 JSR abs 6;21 AND izx 6;24 BIT zp 3;25 AND zp 3;26 ROL zp 5;28 PLP imp 4;29 AND imm 2;2A ROL acc 2;2C BIT abs 4;2D AND abs 4;2E ROL abs 6;
30 BMI rel 2;31 AND izy 5+;35 AND zpx 4;36 ROL zpx 6;38 SEC imp 2;39 AND aby 4+;3D AND abx 4+;3E ROL abx 7;
40 RTI imp 6;41 EOR izx 6;45 EOR zp 3;46 LSR zp 5;48 PHA imp 3;49 EOR imm 2;4A LSR acc 2;4C JMP abs 3;4D EOR abs 4;4E LSR abs 6;
50 BVC rel 2;51 EOR izy 5+;55 EOR zpx 4;56 LSR zpx 6;58 CLI imp 2;59 EOR aby 4+;5D EOR abx 4+;5E LSR abx 7;
60 RTS imp 6;61 ADC izx 6;65 ADC zp 3;66 ROR zp 5;68 PLA imp 4;69 ADC imm 2;6A ROR acc 2;6C JMP ind 5;6D ADC abs 4;6E ROR abs 6;
70 BVS rel 2;71 ADC izy 5+;75 ADC zpx 4;76 ROR zpx 6;78 SEI imp 2;79 ADC aby 4+;7D ADC abx 4+;7E ROR abx 7;
81 STA izx 6;84 STY zp 3;85 STA zp 3;86 STX zp 3;88 DEY imp 2;8A TXA imp 2;8C STY abs 4;8D STA abs 4;8E STX abs 4;
90 BCC rel 2;91 STA izy 6;94 STY zpx 4;95 STA zpx 4;96 STX zpy 4;98 TYA imp 2;99 STA aby 5;9A TXS imp 2;9D STA abx 5;
A0 LDY imm 2;A1 LDA izx 6;A2 LDX imm 2;A4 LDY zp 3;A5 LDA zp 3;A6 LDX zp 3;A8 TAY imp 2;A9 LDA imm 2;AA TAX imp 2;AC LDY abs 4;AD LDA abs 4;AE LDX abs 4;
B0 BCS rel 2;B1 LDA izy 5+;B4 LDY zpx 4;B5 LDA zpx 4;B6 LDX zpy 4;B8 CLV imp 2;B9 LDA aby 4+;BA TSX imp 2;BC LDY abx 4+;BD LDA abx 4+;BE LDX aby 4+;
C0 CPY imm 2;C1 CMP izx 6;C4 CPY zp 3;C5 CMP zp 3;C6 DEC zp 5;C8 INY imp 2;C9 CMP imm 2;CA DEX imp 2;CC CPY abs 4;CD CMP abs 4;CE DEC abs 6;
D0 BNE rel 2;D1 CMP izy 5+;D5 CMP zpx 4;D6 DEC zpx 6;D8 CLD imp 2;D9 CMP aby 4+;DD CMP abx 4+;DE DEC abx 7;
E0 CPX imm 2;E1 SBC izx 6;E4 CPX zp 3;E5 SBC zp 3;E6 INC zp 5;E8 INX imp 2;E9 SBC imm 2;EA NOP imp 2;EC CPX abs 4;ED SBC abs 4;EE INC abs 6;
F0 BEQ rel 2;F1 SBC izy 5+;F5 SBC zpx 4;F6 INC zpx 6;F8 SED imp 2;F9 SBC aby 4+;FD SBC abx 4+;FE INC abx 7;
`;
export const OPCODES = new Map<number, Opcode>();
for (const def of definitions.split(';')) {
  const parts = def.trim().split(/\s+/);
  if (parts.length !== 4) {
    continue;
  }
  const [code, mnemonic, mode, timing] = parts as [string, string, Mode, string];
  const opcode = parseInt(code, 16);
  OPCODES.set(opcode, {
    opcode,
    mnemonic,
    mode,
    size: widths[mode],
    cycles: parseInt(timing),
    pagePenalty: timing.endsWith('+'),
  });
}
/** Reviewed NMOS extensions are opt-in per recipe; the default ISA remains the
 * 151 documented opcodes. These read-and-discard NOPs are used as instruction
 * skips by the supplied Nebulus packer. See src/games/c64/nebulus/docs/BOOT.md. */
export const NMOS_EXTENSIONS = new Map<number, Opcode>(
  [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc].map((opcode) => [
    opcode,
    { opcode, mnemonic: 'NOP', mode: 'abx', size: 3, cycles: 4, pagePenalty: true },
  ]),
);
export interface DecodeOptions {
  undocumentedOpcodes?: readonly number[];
}
export function opcodeFor(opcode: number, options: DecodeOptions = {}): Opcode | undefined {
  return (
    OPCODES.get(opcode) ??
    (options.undocumentedOpcodes?.includes(opcode) ? NMOS_EXTENSIONS.get(opcode) : undefined)
  );
}
export const BRANCHES: Record<string, { flag: number; set: boolean }> = {
  BPL: { flag: 0x80, set: false },
  BMI: { flag: 0x80, set: true },
  BVC: { flag: 0x40, set: false },
  BVS: { flag: 0x40, set: true },
  BCC: { flag: 1, set: false },
  BCS: { flag: 1, set: true },
  BNE: { flag: 2, set: false },
  BEQ: { flag: 2, set: true },
};
export const branchTarget = (address: number, offset: number): number =>
  (address + 2 + (offset < 128 ? offset : offset - 256)) & 0xffff;

function formatOperand(mode: Mode, operand: number, address: number): string {
  const b = `$${hex(operand, 2)}`,
    w = `$${hex(operand)}`;
  switch (mode) {
    case 'imp':
      return '';
    case 'acc':
      return 'A';
    case 'imm':
      return `#${b}`;
    case 'zp':
      return b;
    case 'zpx':
      return `${b},X`;
    case 'zpy':
      return `${b},Y`;
    case 'abs':
      return w;
    case 'abx':
      return `${w},X`;
    case 'aby':
      return `${w},Y`;
    case 'ind':
      return `(${w})`;
    case 'izx':
      return `(${b},X)`;
    case 'izy':
      return `(${b}),Y`;
    case 'rel':
      return `$${hex(branchTarget(address, operand))}`;
  }
}
export function decode(
  memory: Uint8Array,
  address: number,
  options: DecodeOptions = {},
): Instruction {
  if (memory.length !== 65536 || !Number.isInteger(address) || address < 0 || address > 65535) {
    throw new Diagnostic('CPU_ADDRESS', 'Decoder expects a 64 KiB image and 16-bit address.');
  }
  const opcode = memory[address]!;
  const definition = opcodeFor(opcode, options);
  if (!definition) {
    throw new Diagnostic(
      'CPU_UNSUPPORTED_OPCODE',
      `Unsupported NMOS opcode $${hex(opcode, 2)} at $${hex(address)}.`,
    );
  }
  const bytes = Array.from({ length: definition.size }, (_, i) => memory[(address + i) & 0xffff]!);
  const operand = (bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8);
  const suffix = formatOperand(definition.mode, operand, address);
  return {
    ...definition,
    address,
    bytes,
    operand,
    text: `${definition.mnemonic}${suffix ? ' ' + suffix : ''}`,
  };
}
export const listing = (instructions: Instruction[]): string =>
  instructions
    .map(
      (i) =>
        `${hex(i.address)}  ${i.bytes
          .map((b) => hex(b, 2))
          .join(' ')
          .padEnd(8)}  ${i.text}`,
    )
    .join('\n') + '\n';

export interface Gap {
  address: number;
  kind: string;
  detail: string;
}
export interface ControlFlow {
  instructions: Instruction[];
  edges: { from: number; to: number; kind: 'fallthrough' | 'branch' | 'jump' | 'call' }[];
  unresolved: Gap[];
}
export function disassemble(
  space: AddressSpace,
  seeds: number[],
  maxInstructions = 16384,
  options: DecodeOptions = {},
): ControlFlow {
  const found = new Map<number, Instruction>(),
    owners = new Map<number, number>();
  const edges: ControlFlow['edges'] = [],
    unresolved: Gap[] = [],
    pending = [...seeds],
    visited = new Set<number>();
  if (!Number.isInteger(maxInstructions) || maxInstructions < 1 || maxInstructions > 65536) {
    throw new Diagnostic('CPU_BUDGET', 'Instruction budget must be between 1 and 65536.');
  }
  while (pending.length) {
    const address = pending.pop()!;
    if (visited.has(address)) {
      continue;
    }
    visited.add(address);
    if (found.size >= maxInstructions) {
      unresolved.push({ address, kind: 'budget', detail: 'Instruction budget exhausted.' });
      break;
    }
    if (!space.loaded[address]) {
      unresolved.push({
        address,
        kind: 'unmapped',
        detail: 'No loaded or recovered bytes at target.',
      });
      continue;
    }
    let instruction: Instruction;
    try {
      instruction = decode(space.bytes, address, options);
    } catch (e) {
      unresolved.push({ address, kind: 'opcode', detail: (e as Error).message });
      continue;
    }
    if (instruction.bytes.some((_, i) => !space.loaded[(address + i) & 0xffff])) {
      unresolved.push({
        address,
        kind: 'truncated',
        detail: 'Instruction crosses the recovered memory boundary.',
      });
      continue;
    }
    if (instruction.bytes.some((_, i) => owners.has((address + i) & 0xffff))) {
      unresolved.push({
        address,
        kind: 'overlap',
        detail: 'Target overlaps a previously decoded instruction; needs an execution epoch.',
      });
      continue;
    }
    const source = space.source(address);
    if (source) {
      instruction.source = source;
    }
    found.set(address, instruction);
    instruction.bytes.forEach((_, i) => owners.set((address + i) & 0xffff, address));
    const next = (address + instruction.size) & 0xffff;
    const edge = (to: number, kind: ControlFlow['edges'][number]['kind']): void => {
      edges.push({ from: address, to, kind });
      pending.push(to);
    };
    if (BRANCHES[instruction.mnemonic]) {
      edge(branchTarget(address, instruction.operand), 'branch');
      edge(next, 'fallthrough');
    } else if (instruction.mnemonic === 'JMP') {
      if (instruction.mode === 'ind') {
        unresolved.push({
          address,
          kind: 'indirect',
          detail: 'Indirect jump requires an observed target and mapped-byte epoch.',
        });
      } else {
        edge(instruction.operand, 'jump');
      }
    } else if (instruction.mnemonic === 'JSR') {
      edge(instruction.operand, 'call');
      edge(next, 'fallthrough');
    } else if (['RTS', 'RTI', 'BRK'].includes(instruction.mnemonic)) {
      unresolved.push({
        address,
        kind: 'dynamic-control',
        detail: `${instruction.mnemonic} requires stack or interrupt state.`,
      });
    } else {
      edge(next, 'fallthrough');
    }
  }
  return {
    instructions: [...found.values()].sort((a, b) => a.address - b.address),
    edges,
    unresolved,
  };
}
