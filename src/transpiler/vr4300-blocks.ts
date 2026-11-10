import { lowerVr4300, type Vr4300Instruction } from './vr4300.js';

/**
 * Play tier: compiles recovered VR4300 instructions into basic-block
 * functions. The reference tier keeps one guarded function per instruction
 * for Learn, ROM Desk and verification; Play may run these blocks instead.
 *
 * A block runs straight-line from a branch target or fall-through address
 * up to and including the next branch and its delay slot. It checks every
 * original instruction word on entry and returns 0 without effects when any
 * word differs, so the reference functions run instead. Common integer
 * operations use exact 64-bit arithmetic on the register file's 32-bit
 * halves rather than BigInt. Loads and stores to KSEG0/KSEG1 RDRAM read and
 * write memory directly; every other access takes the reference path,
 * including its faults. Time is accounted once per block by the machine.
 *
 * Generated function signature: (s: Vr4300Machine, w: Int32Array registers
 * as low/high words on a little-endian host, m: DataView of RDRAM) → number
 * of instructions retired, or 0 when the block did not run.
 */

const maximumBlock = 64;
const stops = new Set(['ERET', 'SYSCALL', 'BREAK', 'TLBWI', 'TLBWR', 'TLBP', 'TLBR']);

function isBranch(mnemonic: string): boolean {
  return (mnemonic.startsWith('B') && mnemonic !== 'BREAK') || mnemonic.startsWith('J');
}

const hex = (value: number) => '0x' + (value >>> 0).toString(16);
const low = (r: number) => (r === 0 ? '0' : `w[${r * 2}]`);
const high = (r: number) => (r === 0 ? '0' : `w[${r * 2 + 1}]`);

function set32(rd: number, expression: string): string {
  return rd === 0
    ? ''
    : `{ const v = (${expression}) | 0; w[${rd * 2}] = v; w[${rd * 2 + 1}] = v >> 31; }`;
}
function set64(rd: number, lowExpression: string, highExpression: string): string {
  return rd === 0
    ? ''
    : `{ const lo = ${lowExpression}, hi = ${highExpression}; w[${rd * 2}] = lo; w[${rd * 2 + 1}] = hi; }`;
}
function lessThan(
  aLow: string,
  aHigh: string,
  bLow: string,
  bHigh: string,
  signed: boolean,
): string {
  const highLess = signed ? `${aHigh} < ${bHigh}` : `(${aHigh} >>> 0) < (${bHigh} >>> 0)`;
  return `(${highLess} || (${aHigh} === ${bHigh} && (${aLow} >>> 0) < (${bLow} >>> 0)))`;
}
function add64(rd: number, aLow: string, aHigh: string, bLow: string, bHigh: string): string {
  return rd === 0
    ? ''
    : `{ const lo = (${aLow} >>> 0) + (${bLow} >>> 0), hi = (${aHigh} + ${bHigh} + (lo > 4294967295 ? 1 : 0)) | 0; w[${rd * 2}] = lo | 0; w[${rd * 2 + 1}] = hi; }`;
}
function subtract64(rd: number, aLow: string, aHigh: string, bLow: string, bHigh: string): string {
  return rd === 0
    ? ''
    : `{ const lo = (${aLow} >>> 0) - (${bLow} >>> 0), hi = (${aHigh} - ${bHigh} - (lo < 0 ? 1 : 0)) | 0; w[${rd * 2}] = lo | 0; w[${rd * 2 + 1}] = hi; }`;
}

const loads: Record<string, [number, string, boolean]> = {
  LB: [1, 'getInt8', true],
  LBU: [1, 'getUint8', false],
  LH: [2, 'getInt16', true],
  LHU: [2, 'getUint16', false],
  LW: [4, 'getInt32', true],
  LWU: [4, 'getUint32', false],
  LD: [8, '', true],
};
const stores: Record<string, [number, string]> = {
  SB: [1, 'setInt8'],
  SH: [2, 'setInt16'],
  SW: [4, 'setInt32'],
  SD: [8, ''],
};

/** Direct RDRAM access when the 64-bit effective address is a sign-extended
 * KSEG0/KSEG1 address inside installed RDRAM and naturally aligned. */
function memory(instruction: Vr4300Instruction, mark: string): string | undefined {
  const { mnemonic, rs, rt, signedImmediate } = instruction;
  const load = loads[mnemonic],
    store = stores[mnemonic];
  if (!load && !store) {
    return undefined;
  }
  const size = load ? load[0] : store![0];
  const condition =
    `${high(rs)} === (${low(rs)} >> 31) && a < -1073741824` +
    (size > 1 ? ` && (a & ${size - 1}) === 0` : '') +
    ` && (a & 0x1fffffff) + ${size} <= m.byteLength`;
  let fast: string;
  if (load) {
    const [, getter, signed] = load;
    if (rt === 0) {
      fast = '';
    } else if (size === 8) {
      fast = `w[${rt * 2 + 1}] = m.getInt32(p); w[${rt * 2}] = m.getInt32(p + 4);`;
    } else if (signed) {
      fast = `const v = m.${getter}(p); w[${rt * 2}] = v; w[${rt * 2 + 1}] = v >> 31;`;
    } else {
      fast = `w[${rt * 2}] = m.${getter}(p); w[${rt * 2 + 1}] = 0;`;
    }
  } else {
    const [, setter] = store!;
    fast =
      size === 8
        ? `m.setInt32(p, ${high(rt)}); m.setInt32(p + 4, ${low(rt)});`
        : `m.${setter}(p, ${low(rt)});`;
  }
  return `{ const a = ${low(rs)} + ${signedImmediate}; if (${condition}) { const p = a & 0x1fffffff; ${fast} } else { ${mark} ${lowerVr4300(instruction)} } }`;
}

/** Inline lowering for operations that cannot fault. */
function pure(instruction: Vr4300Instruction): string | undefined {
  const { mnemonic, rs, rt, rd, shift, immediate, signedImmediate } = instruction;
  const signHigh = signedImmediate < 0 ? '-1' : '0';
  switch (mnemonic) {
    case 'NOP':
    case 'SYNC':
      return '';
    case 'LUI':
      return set32(rt, String((immediate << 16) | 0));
    case 'ADDIU':
      return set32(rt, `${low(rs)} + ${signedImmediate}`);
    case 'ADDU':
      return set32(rd, `${low(rs)} + ${low(rt)}`);
    case 'SUBU':
      return set32(rd, `${low(rs)} - ${low(rt)}`);
    case 'SLL':
      return set32(rd, `${low(rt)} << ${shift}`);
    case 'SRL':
      return set32(rd, `${low(rt)} >>> ${shift}`);
    case 'SRA':
      return set32(rd, `${low(rt)} >> ${shift}`);
    case 'SLLV':
      return set32(rd, `${low(rt)} << (${low(rs)} & 31)`);
    case 'SRLV':
      return set32(rd, `${low(rt)} >>> (${low(rs)} & 31)`);
    case 'SRAV':
      return set32(rd, `${low(rt)} >> (${low(rs)} & 31)`);
    case 'OR':
      return set64(rd, `${low(rs)} | ${low(rt)}`, `${high(rs)} | ${high(rt)}`);
    case 'AND':
      return set64(rd, `${low(rs)} & ${low(rt)}`, `${high(rs)} & ${high(rt)}`);
    case 'XOR':
      return set64(rd, `${low(rs)} ^ ${low(rt)}`, `${high(rs)} ^ ${high(rt)}`);
    case 'NOR':
      return set64(rd, `~(${low(rs)} | ${low(rt)})`, `~(${high(rs)} | ${high(rt)})`);
    case 'ANDI':
      return set64(rt, `${low(rs)} & ${immediate}`, '0');
    case 'ORI':
      return set64(rt, `${low(rs)} | ${immediate}`, high(rs));
    case 'XORI':
      return set64(rt, `${low(rs)} ^ ${immediate}`, high(rs));
    case 'SLT':
      return set64(rd, `${lessThan(low(rs), high(rs), low(rt), high(rt), true)} ? 1 : 0`, '0');
    case 'SLTU':
      return set64(rd, `${lessThan(low(rs), high(rs), low(rt), high(rt), false)} ? 1 : 0`, '0');
    case 'SLTI':
      return set64(
        rt,
        `${lessThan(low(rs), high(rs), String(signedImmediate), signHigh, true)} ? 1 : 0`,
        '0',
      );
    case 'SLTIU':
      return set64(
        rt,
        `${lessThan(low(rs), high(rs), String(signedImmediate), signHigh, false)} ? 1 : 0`,
        '0',
      );
    case 'DADDIU':
      return add64(rt, low(rs), high(rs), String(signedImmediate), signHigh);
    case 'DADDU':
      return add64(rd, low(rs), high(rs), low(rt), high(rt));
    case 'DSUBU':
      return subtract64(rd, low(rs), high(rs), low(rt), high(rt));
    case 'DSLL':
      return shift === 0
        ? set64(rd, low(rt), high(rt))
        : set64(
            rd,
            `${low(rt)} << ${shift}`,
            `(${high(rt)} << ${shift}) | (${low(rt)} >>> ${32 - shift})`,
          );
    case 'DSRL':
      return shift === 0
        ? set64(rd, low(rt), high(rt))
        : set64(
            rd,
            `(${low(rt)} >>> ${shift}) | (${high(rt)} << ${32 - shift})`,
            `${high(rt)} >>> ${shift}`,
          );
    case 'DSRA':
      return shift === 0
        ? set64(rd, low(rt), high(rt))
        : set64(
            rd,
            `(${low(rt)} >>> ${shift}) | (${high(rt)} << ${32 - shift})`,
            `${high(rt)} >> ${shift}`,
          );
    case 'DSLL32':
      return set64(rd, '0', `${low(rt)} << ${shift}`);
    case 'DSRL32':
      return set64(rd, `${high(rt)} >>> ${shift}`, '0');
    case 'DSRA32':
      return set64(rd, `${high(rt)} >> ${shift}`, `${high(rt)} >> 31`);
  }
  return undefined;
}

function operation(instruction: Vr4300Instruction, mark: string): string {
  const inline = pure(instruction);
  if (inline !== undefined) {
    return inline;
  }
  return memory(instruction, mark) ?? `${mark} ${lowerVr4300(instruction)}`;
}

function condition(instruction: Vr4300Instruction): string {
  const { mnemonic, rs, rt } = instruction;
  if (mnemonic.startsWith('BC1')) {
    return mnemonic.includes('T') ? 's.fpu.condition' : '!s.fpu.condition';
  }
  if (mnemonic.startsWith('BEQ')) {
    return `${low(rs)} === ${low(rt)} && ${high(rs)} === ${high(rt)}`;
  }
  if (mnemonic.startsWith('BNE')) {
    return `!(${low(rs)} === ${low(rt)} && ${high(rs)} === ${high(rt)})`;
  }
  if (mnemonic.startsWith('BLEZ')) {
    return `${high(rs)} < 0 || (${high(rs)} === 0 && ${low(rs)} === 0)`;
  }
  if (mnemonic.startsWith('BGTZ')) {
    return `${high(rs)} > 0 || (${high(rs)} === 0 && ${low(rs)} !== 0)`;
  }
  if (mnemonic.startsWith('BLTZ')) {
    return `${high(rs)} < 0`;
  }
  if (mnemonic.startsWith('BGEZ')) {
    return `${high(rs)} >= 0`;
  }
  throw new Error(`No block condition for ${mnemonic}.`);
}

const jumpTarget = (rs: number) =>
  `${high(rs)} === (${low(rs)} >> 31) ? ${low(rs)} >>> 0 : s.address(s.r(${rs}))`;

/** One block's source, or undefined when its first instruction cannot start one. */
function emitBlock(list: readonly Vr4300Instruction[]): string {
  const start = list[0]!.address,
    count = list.length,
    last = list[count - 1]!,
    branchIndex = count >= 2 && isBranch(list[count - 2]!.mnemonic) ? count - 2 : -1;
  const guard = list
    .map((i) => `m.getInt32(${hex(i.address & 0x1fffffff)}) !== ${i.word | 0}`)
    .join(' || ');
  const body: string[] = [];
  const mark = (index: number) => `s.pc = ${hex(list[index]!.address)}; i = ${index};`;
  const limit = branchIndex >= 0 ? branchIndex : count;
  for (let index = 0; index < limit; index++) {
    body.push(operation(list[index]!, mark(index)));
  }
  if (branchIndex < 0) {
    body.push(`s.endBlock(${hex(last.address + 4)}, ${count}); return ${count};`);
  } else {
    const branch = list[branchIndex]!,
      slot = list[count - 1]!,
      { mnemonic, address, rs, rd } = branch,
      fallThrough = hex(address + 8),
      slotCode = operation(slot, `s.blockSlot(${hex(slot.address)}); i = ${count - 1};`);
    body.push(`s.pc = ${hex(address)}; i = ${branchIndex};`);
    if (mnemonic === 'J' || mnemonic === 'JAL') {
      if (mnemonic === 'JAL') {
        body.push(set32(31, hex(address + 8)));
      }
      body.push(slotCode, `s.endBlock(${hex(branch.target)}, ${count}); return ${count};`);
    } else if (mnemonic === 'JR' || mnemonic === 'JALR') {
      body.push(`const target = ${jumpTarget(rs)};`);
      if (mnemonic === 'JALR') {
        body.push(set32(rd, hex(address + 8)));
      }
      body.push(slotCode, `s.endBlock(target, ${count}); return ${count};`);
    } else {
      const likely = mnemonic.endsWith('L') && !mnemonic.endsWith('AL');
      body.push(`const taken = ${condition(branch)};`);
      if (mnemonic.includes('AL')) {
        body.push(set32(31, hex(address + 8)));
      }
      if (likely) {
        body.push(
          `if (taken) { ${slotCode} s.endBlock(${hex(branch.target)}, ${count}); return ${count}; }`,
          `s.endBlock(${fallThrough}, ${count - 1}); return ${count - 1};`,
        );
      } else {
        body.push(
          slotCode,
          `s.endBlock(taken ? ${hex(branch.target)} : ${fallThrough}, ${count}); return ${count};`,
        );
      }
    }
  }
  return [
    `function b_${(start >>> 0).toString(16)}(s, w, m) {`,
    `  if (${guard}) return 0;`,
    '  let i = 0;',
    '  try {',
    ...body.filter(Boolean).map((line) => '    ' + line),
    '  } catch (error) { s.blockTicks = i + 1; throw error; }',
    '}',
  ].join('\n');
}

export interface Vr4300BlockProgram {
  /** Modules relative to game-code/: the play-blocks.js index and its parts. */
  files: Record<string, string>;
  /** The standalone part modules, each exporting its own `blocks` map. */
  parts: string[];
  blocks: number;
  instructions: number;
}

/** Each part stays well below the site's 16 MiB per-file input limit. */
const partBytes = 4000000;
const header = [
  '// Generated by ROM Studio: play-tier VR4300 basic blocks. Reference',
  '// per-instruction functions remain the verified path for Learn and Desk.',
];

/** Emits the play-tier block module for recovered KSEG0/KSEG1 code. */
export function emitVr4300Blocks(
  instructions: readonly Vr4300Instruction[],
  entries: readonly number[] = [],
): Vr4300BlockProgram {
  const byAddress = new Map<number, Vr4300Instruction>();
  const variants = new Set<number>();
  for (const instruction of instructions) {
    if (
      byAddress.has(instruction.address) &&
      byAddress.get(instruction.address)!.word !== instruction.word
    ) {
      variants.add(instruction.address);
    }
    byAddress.set(instruction.address, instruction);
  }
  const usable = (address: number) => {
    const instruction = byAddress.get(address);
    return instruction && !variants.has(address) && address >= 0x80000000 && address < 0xc0000000
      ? instruction
      : undefined;
  };
  // The exception vector and any caller-declared entry points also start blocks.
  const starts = new Set<number>([0x80000180, ...entries.map((entry) => entry >>> 0)]);
  for (const instruction of byAddress.values()) {
    if (isBranch(instruction.mnemonic)) {
      if (instruction.mnemonic !== 'JR' && instruction.mnemonic !== 'JALR') {
        starts.add(instruction.target >>> 0);
      }
      starts.add((instruction.address + 8) >>> 0);
    }
  }
  const emitted = new Map<number, string>();
  let covered = 0;
  const pending = [...starts];
  while (pending.length) {
    const start = pending.pop()!;
    if (emitted.has(start)) {
      continue;
    }
    const first = usable(start);
    // The machine summarizes BEQ $0,$0,-1 + NOP wait loops separately.
    if (!first || first.word === 0x1000ffff) {
      continue;
    }
    const list: Vr4300Instruction[] = [];
    let address = start,
      continuation: number | undefined;
    for (;;) {
      const instruction = usable(address);
      if (!instruction || stops.has(instruction.mnemonic)) {
        break;
      }
      if (isBranch(instruction.mnemonic)) {
        const slot = usable(address + 4);
        if (slot && !isBranch(slot.mnemonic) && !stops.has(slot.mnemonic)) {
          list.push(instruction, slot);
        }
        break;
      }
      list.push(instruction);
      address += 4;
      if (list.length >= maximumBlock) {
        continuation = address;
        break;
      }
    }
    if (!list.length) {
      continue;
    }
    emitted.set(start, emitBlock(list));
    covered += list.length;
    if (continuation !== undefined) {
      pending.push(continuation);
    }
  }
  const ordered = [...emitted.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  const flush = (starts: number[]) =>
    parts.push(
      [
        ...header,
        ...starts.map((start) => emitted.get(start)!),
        `export const blocks = new Map([${starts.map((start) => `[${hex(start)}, b_${start.toString(16)}]`).join(', ')}]);`,
        '',
      ].join('\n'),
    );
  let group: number[] = [],
    size = 0;
  for (const start of ordered) {
    const length = emitted.get(start)!.length;
    if (group.length && size + length > partBytes) {
      flush(group);
      group = [];
      size = 0;
    }
    group.push(start);
    size += length;
  }
  if (group.length) {
    flush(group);
  }
  const name = (index: number) => `play-blocks/${index.toString(16).padStart(4, '0')}.js`;
  const files: Record<string, string> = {
    'play-blocks.js': [
      ...header,
      "export const architecture = 'mips3-vr4300-blocks';",
      ...parts.map((_, index) => `import { blocks as part${index} } from './${name(index)}';`),
      `export const blocks = new Map([${parts.map((_, index) => `...part${index}`).join(', ')}]);`,
      '',
    ].join('\n'),
  };
  parts.forEach((source, index) => {
    files[name(index)] = source;
  });
  return { files, parts, blocks: emitted.size, instructions: covered };
}
