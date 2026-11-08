import { Diagnostic } from '../core.js';
import type { Vr4300Machine } from '../runtime/vr4300.js';

export interface Vr4300Instruction {
  address: number;
  word: number;
  opcode: number;
  rs: number;
  rt: number;
  rd: number;
  shift: number;
  immediate: number;
  signedImmediate: number;
  target: number;
  mnemonic: string;
  text: string;
  bytes: number[];
}
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
  'fp',
  'ra',
];
const register = (index: number) => '$' + names[index];
const hex = (value: number, width = 8) =>
  '$' + (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
const literal = (value: number) => '0x' + (value >>> 0).toString(16).padStart(8, '0');
const immediateOps: Readonly<Record<number, string>> = {
  8: 'ADDI',
  9: 'ADDIU',
  10: 'SLTI',
  11: 'SLTIU',
  12: 'ANDI',
  13: 'ORI',
  14: 'XORI',
  15: 'LUI',
  24: 'DADDI',
  25: 'DADDIU',
};
const branches: Readonly<Record<number, string>> = {
  4: 'BEQ',
  5: 'BNE',
  6: 'BLEZ',
  7: 'BGTZ',
  20: 'BEQL',
  21: 'BNEL',
  22: 'BLEZL',
  23: 'BGTZL',
};
const loads: Readonly<Record<number, string>> = {
  26: 'LDL',
  27: 'LDR',
  32: 'LB',
  33: 'LH',
  34: 'LWL',
  35: 'LW',
  36: 'LBU',
  37: 'LHU',
  38: 'LWR',
  39: 'LWU',
  40: 'SB',
  41: 'SH',
  42: 'SWL',
  43: 'SW',
  44: 'SDL',
  45: 'SDR',
  46: 'SWR',
  55: 'LD',
  63: 'SD',
};
const special: Readonly<Record<number, string>> = {
  0: 'SLL',
  2: 'SRL',
  3: 'SRA',
  4: 'SLLV',
  6: 'SRLV',
  7: 'SRAV',
  8: 'JR',
  9: 'JALR',
  12: 'SYSCALL',
  13: 'BREAK',
  15: 'SYNC',
  16: 'MFHI',
  17: 'MTHI',
  18: 'MFLO',
  19: 'MTLO',
  20: 'DSLLV',
  22: 'DSRLV',
  23: 'DSRAV',
  24: 'MULT',
  25: 'MULTU',
  26: 'DIV',
  27: 'DIVU',
  28: 'DMULT',
  29: 'DMULTU',
  30: 'DDIV',
  31: 'DDIVU',
  32: 'ADD',
  33: 'ADDU',
  34: 'SUB',
  35: 'SUBU',
  36: 'AND',
  37: 'OR',
  38: 'XOR',
  39: 'NOR',
  42: 'SLT',
  43: 'SLTU',
  44: 'DADD',
  45: 'DADDU',
  46: 'DSUB',
  47: 'DSUBU',
  56: 'DSLL',
  58: 'DSRL',
  59: 'DSRA',
  60: 'DSLL32',
  62: 'DSRL32',
  63: 'DSRA32',
};

export function decodeVr4300(word: number, address: number): Vr4300Instruction {
  if (
    !Number.isInteger(word) ||
    word < 0 ||
    word > 0xffffffff ||
    !Number.isInteger(address) ||
    address < 0 ||
    address > 0xffffffff ||
    address % 4 !== 0
  ) {
    throw new Diagnostic('MIPS_WORD', 'Expected an aligned 32-bit instruction word and address.');
  }
  const opcode = word >>> 26,
    rs = (word >>> 21) & 31,
    rt = (word >>> 16) & 31,
    rd = (word >>> 11) & 31,
    shift = (word >>> 6) & 31;
  const immediate = word & 65535,
    signedImmediate = (immediate << 16) >> 16;
  let mnemonic = '',
    operands = '',
    target = (address + 4 + signedImmediate * 4) >>> 0;
  if (word === 0) {
    mnemonic = 'NOP';
  } else if (opcode === 0) {
    mnemonic = special[word & 63] ?? '';
    operands =
      mnemonic === 'JR' || mnemonic === 'MTHI' || mnemonic === 'MTLO'
        ? register(rs)
        : mnemonic === 'JALR'
          ? `${register(rd)}, ${register(rs)}`
          : mnemonic === 'MFHI' || mnemonic === 'MFLO'
            ? register(rd)
            : ['SLL', 'SRL', 'SRA', 'DSLL', 'DSRL', 'DSRA', 'DSLL32', 'DSRL32', 'DSRA32'].includes(
                  mnemonic,
                )
              ? `${register(rd)}, ${register(rt)}, ${shift}`
              : mnemonic.endsWith('V')
                ? `${register(rd)}, ${register(rt)}, ${register(rs)}`
                : /^(?:D?MULT|D?DIV)U?$/.test(mnemonic)
                  ? `${register(rs)}, ${register(rt)}`
                  : ['SYNC', 'SYSCALL', 'BREAK'].includes(mnemonic)
                    ? ''
                    : `${register(rd)}, ${register(rs)}, ${register(rt)}`;
  } else if (opcode === 2 || opcode === 3) {
    mnemonic = opcode === 2 ? 'J' : 'JAL';
    target = (((address + 4) & 0xf0000000) | ((word & 0x3ffffff) << 2)) >>> 0;
    operands = hex(target);
  } else if (opcode === 1) {
    mnemonic =
      (
        {
          0: 'BLTZ',
          1: 'BGEZ',
          2: 'BLTZL',
          3: 'BGEZL',
          16: 'BLTZAL',
          17: 'BGEZAL',
          18: 'BLTZALL',
          19: 'BGEZALL',
        } as Record<number, string>
      )[rt] ?? '';
    operands = `${register(rs)}, ${hex(target)}`;
  } else if (opcode === 16) {
    if (rs === 0 || rs === 4) {
      mnemonic = rs === 0 ? 'MFC0' : 'MTC0';
      operands = `${register(rt)}, $${rd}`;
    } else if (rs === 16 && (word & 63) === 2) {
      mnemonic = 'TLBWI';
    } else if (rs === 16 && (word & 63) === 6) {
      mnemonic = 'TLBWR';
    } else if (word === 0x42000001) {
      mnemonic = 'TLBR';
    } else if (word === 0x42000008) {
      mnemonic = 'TLBP';
    } else if (word === 0x42000018) {
      mnemonic = 'ERET';
    }
  } else if (opcode === 17 && (rs === 2 || rs === 6)) {
    mnemonic = rs === 2 ? 'CFC1' : 'CTC1';
    operands = `${register(rt)}, $${rd}`;
  } else if (opcode === 17 && [0, 1, 4, 5].includes(rs)) {
    mnemonic = ({ 0: 'MFC1', 1: 'DMFC1', 4: 'MTC1', 5: 'DMTC1' } as Record<number, string>)[rs]!;
    operands = `${register(rt)}, $f${rd}`;
  } else if (opcode === 17 && rs === 8 && rt < 4) {
    mnemonic = ['BC1F', 'BC1T', 'BC1FL', 'BC1TL'][rt]!;
    operands = hex(target);
  } else if (opcode === 17 && [16, 17, 20, 21].includes(rs)) {
    const format = ({ 16: 'S', 17: 'D', 20: 'W', 21: 'L' } as Record<number, string>)[rs]!;
    const operation = word & 63;
    if (operation >= 48 && rs < 20) {
      const condition = [
        'F',
        'UN',
        'EQ',
        'UEQ',
        'OLT',
        'ULT',
        'OLE',
        'ULE',
        'SF',
        'NGLE',
        'SEQ',
        'NGL',
        'LT',
        'NGE',
        'LE',
        'NGT',
      ][operation & 15]!;
      mnemonic = `C.${condition}.${format}`;
      operands = `$f${rd}, $f${rt}`;
    } else {
      const name = (
        {
          0: 'ADD',
          1: 'SUB',
          2: 'MUL',
          3: 'DIV',
          4: 'SQRT',
          5: 'ABS',
          6: 'MOV',
          7: 'NEG',
          8: 'ROUND.L',
          9: 'TRUNC.L',
          10: 'CEIL.L',
          11: 'FLOOR.L',
          12: 'ROUND.W',
          13: 'TRUNC.W',
          14: 'CEIL.W',
          15: 'FLOOR.W',
          32: 'CVT.S',
          33: 'CVT.D',
          36: 'CVT.W',
          37: 'CVT.L',
        } as Record<number, string>
      )[operation];
      if (name && (rs < 20 || operation === 32 || operation === 33)) {
        mnemonic = `${name}.${format}`;
        operands = `$f${shift}, $f${rd}${operation < 4 ? `, $f${rt}` : ''}`;
      }
    }
  } else if ([49, 53, 57, 61].includes(opcode)) {
    mnemonic = ({ 49: 'LWC1', 53: 'LDC1', 57: 'SWC1', 61: 'SDC1' } as Record<number, string>)[
      opcode
    ]!;
    operands = `$f${rt}, ${signedImmediate}(${register(rs)})`;
  } else if (opcode === 47) {
    mnemonic = 'CACHE';
    operands = `${rt}, ${signedImmediate}(${register(rs)})`;
  } else if (branches[opcode]) {
    mnemonic = branches[opcode]!;
    operands =
      opcode === 6 || opcode === 7 || opcode === 22 || opcode === 23
        ? `${register(rs)}, ${hex(target)}`
        : `${register(rs)}, ${register(rt)}, ${hex(target)}`;
  } else if (immediateOps[opcode]) {
    mnemonic = immediateOps[opcode]!;
    operands =
      mnemonic === 'LUI'
        ? `${register(rt)}, ${hex(immediate, 4)}`
        : `${register(rt)}, ${register(rs)}, ${opcode >= 12 && opcode <= 14 ? hex(immediate, 4) : signedImmediate}`;
  } else if (loads[opcode]) {
    mnemonic = loads[opcode]!;
    operands = `${register(rt)}, ${signedImmediate}(${register(rs)})`;
  }
  if (!mnemonic) {
    throw new Diagnostic(
      'MIPS_UNSUPPORTED_OPCODE',
      `Unsupported VR4300 instruction ${hex(word)} at ${hex(address)}.`,
    );
  }
  return {
    address,
    word,
    opcode,
    rs,
    rt,
    rd,
    shift,
    immediate,
    signedImmediate,
    target,
    mnemonic,
    text: mnemonic + (operands ? ' ' + operands : ''),
    bytes: [word >>> 24, (word >>> 16) & 255, (word >>> 8) & 255, word & 255],
  };
}

function lower(instruction: Vr4300Instruction): string {
  const { rs, rt, rd, shift, immediate, signedImmediate, target, address, mnemonic } = instruction;
  const source = `s.r(${rs})`,
    other = `s.r(${rt})`;
  if (instruction.opcode === 17 && rs >= 16) {
    return `s.fpu.execute('${mnemonic}', ${shift}, ${rd}, ${rt});`;
  }
  if (mnemonic.startsWith('BC1')) {
    return `s.branch(${mnemonic.includes('T') ? '' : '!'}s.fpu.condition, ${target}, ${mnemonic.endsWith('L')});`;
  }
  switch (mnemonic) {
    case 'NOP':
    case 'SYNC':
      return '';
    case 'BREAK':
      return "s.raiseException(9, 'breakpoint', 'Guest BREAK instruction.');";
    case 'SYSCALL':
      return "s.raiseException(8, 'syscall', 'Guest SYSCALL instruction.');";
    case 'MFC0':
      return `s.set32(${rt}, s.control.read(${rd}));`;
    case 'MTC0':
      return `s.control.write(${rd}, s.r32(${rt}));`;
    case 'CFC1':
      return `s.readFpuControl(${rt}, ${rd});`;
    case 'CTC1':
      return `s.writeFpuControl(${rt}, ${rd});`;
    case 'MFC1':
      return `s.set32(${rt}, s.fpu.word(${rd}));`;
    case 'MTC1':
      return `s.fpu.setWord(${rd}, s.r32(${rt}));`;
    case 'DMFC1':
      return `s.set64(${rt}, s.fpu.doubleword(${rd}));`;
    case 'DMTC1':
      return `s.fpu.setDoubleword(${rd}, s.u(${rt}));`;
    case 'LWC1':
    case 'LDC1':
    case 'SWC1':
    case 'SDC1':
      return `s.fpuMemory(${rt}, ${rs}, ${signedImmediate}, ${mnemonic.endsWith('DC1')}, ${mnemonic.startsWith('S')});`;
    case 'TLBWI':
    case 'TLBWR':
      return `s.control.writeTlb(${mnemonic === 'TLBWR'});`;
    case 'ERET':
      return 's.returnFromException();';
    case 'TLBP':
      return 's.control.probeTlb();';
    case 'TLBR':
      return 's.control.readTlb();';
    case 'CACHE':
      return `s.cache(${rt}, ${rs}, ${signedImmediate});`;
    case 'LWL':
    case 'LWR':
    case 'LDL':
    case 'LDR':
    case 'SWL':
    case 'SWR':
    case 'SDL':
    case 'SDR':
      return `s.mergeMemory(${rt}, ${rs}, ${signedImmediate}, ${mnemonic[1] === 'D' ? 8 : 4}, ${mnemonic.endsWith('L')}, ${mnemonic.startsWith('S')});`;
    case 'LUI':
      return `s.set32(${rt}, ${literal(immediate << 16)});`;
    case 'ADDI':
    case 'ADDIU':
      return `s.add32(${rt}, s.r32(${rs}), ${signedImmediate}, ${mnemonic === 'ADDI'});`;
    case 'DADDIU':
      return `s.set64(${rt}, ${source} + ${signedImmediate}n);`;
    case 'DADDI':
      return `s.add64(${rt}, ${source}, ${signedImmediate}n, true);`;
    case 'ANDI':
      return `s.set64(${rt}, ${source} & ${immediate}n);`;
    case 'ORI':
      return `s.set64(${rt}, ${source} | ${immediate}n);`;
    case 'XORI':
      return `s.set64(${rt}, ${source} ^ ${immediate}n);`;
    case 'SLTI':
      return `s.set64(${rt}, ${source} < ${signedImmediate}n ? 1n : 0n);`;
    case 'SLTIU':
      return `s.set64(${rt}, s.u(${rs}) < ${BigInt.asUintN(64, BigInt(signedImmediate))}n ? 1n : 0n);`;
    case 'SLL':
      return `s.set32(${rd}, s.r32(${rt}) << ${shift});`;
    case 'SRL':
      return `s.set32(${rd}, s.r32(${rt}) >>> ${shift});`;
    case 'SRA':
      return `s.set32(${rd}, s.r32(${rt}) >> ${shift});`;
    case 'SLLV':
      return `s.set32(${rd}, s.r32(${rt}) << (s.r32(${rs}) & 31));`;
    case 'SRLV':
      return `s.set32(${rd}, s.r32(${rt}) >>> (s.r32(${rs}) & 31));`;
    case 'SRAV':
      return `s.set32(${rd}, s.r32(${rt}) >> (s.r32(${rs}) & 31));`;
    case 'DSLL':
    case 'DSLL32':
      return `s.set64(${rd}, ${other} << ${shift + (mnemonic.endsWith('32') ? 32 : 0)}n);`;
    case 'DSRL':
    case 'DSRL32':
      return `s.set64(${rd}, s.u(${rt}) >> ${shift + (mnemonic.endsWith('32') ? 32 : 0)}n);`;
    case 'DSRA':
    case 'DSRA32':
      return `s.set64(${rd}, ${other} >> ${shift + (mnemonic.endsWith('32') ? 32 : 0)}n);`;
    case 'DSLLV':
      return `s.set64(${rd}, ${other} << (${source} & 63n));`;
    case 'DSRLV':
      return `s.set64(${rd}, s.u(${rt}) >> (${source} & 63n));`;
    case 'DSRAV':
      return `s.set64(${rd}, ${other} >> (${source} & 63n));`;
    case 'ADD':
    case 'ADDU':
      return `s.add32(${rd}, s.r32(${rs}), s.r32(${rt}), ${mnemonic === 'ADD'});`;
    case 'SUB':
    case 'SUBU':
      return `s.add32(${rd}, s.r32(${rs}), -s.r32(${rt}), ${mnemonic === 'SUB'});`;
    case 'DADDU':
      return `s.set64(${rd}, ${source} + ${other});`;
    case 'DSUBU':
      return `s.set64(${rd}, ${source} - ${other});`;
    case 'DADD':
      return `s.add64(${rd}, ${source}, ${other}, true);`;
    case 'DSUB':
      return `s.add64(${rd}, ${source}, -${other}, true);`;
    case 'MULT':
    case 'MULTU':
    case 'DMULT':
    case 'DMULTU':
      return `s.multiply(${rs}, ${rt}, ${mnemonic.startsWith('D') ? 64 : 32}, ${!mnemonic.endsWith('U')});`;
    case 'DIV':
    case 'DIVU':
    case 'DDIV':
    case 'DDIVU':
      return `s.divide(${rs}, ${rt}, ${mnemonic.startsWith('DD') ? 64 : 32}, ${!mnemonic.endsWith('U')});`;
    case 'AND':
      return `s.set64(${rd}, ${source} & ${other});`;
    case 'OR':
      return `s.set64(${rd}, ${source} | ${other});`;
    case 'XOR':
      return `s.set64(${rd}, ${source} ^ ${other});`;
    case 'NOR':
      return `s.set64(${rd}, ~(${source} | ${other}));`;
    case 'SLT':
      return `s.set64(${rd}, ${source} < ${other} ? 1n : 0n);`;
    case 'SLTU':
      return `s.set64(${rd}, s.u(${rs}) < s.u(${rt}) ? 1n : 0n);`;
    case 'MFHI':
      return `s.set64(${rd}, s.hi);`;
    case 'MFLO':
      return `s.set64(${rd}, s.lo);`;
    case 'MTHI':
      return `s.hi = ${source};`;
    case 'MTLO':
      return `s.lo = ${source};`;
    case 'JR':
      return `s.branch(true, s.address(${source}));`;
    case 'JALR':
      return `const target = s.address(${source}); s.set32(${rd}, ${literal(address + 8)}); s.branch(true, target);`;
    case 'J':
      return `s.branch(true, ${literal(target)});`;
    case 'JAL':
      return `s.set32(31, ${literal(address + 8)}); s.branch(true, ${literal(target)});`;
  }
  if (/^(?:BEQ|BNE|BLEZ|BGTZ|BLTZ|BGEZ)/.test(mnemonic)) {
    const condition = mnemonic.startsWith('BEQ')
      ? `${source} === ${other}`
      : mnemonic.startsWith('BNE')
        ? `${source} !== ${other}`
        : mnemonic.startsWith('BLEZ')
          ? `${source} <= 0n`
          : mnemonic.startsWith('BGTZ')
            ? `${source} > 0n`
            : mnemonic.startsWith('BLTZ')
              ? `${source} < 0n`
              : `${source} >= 0n`;
    const link = mnemonic.includes('AL') ? `s.set32(31, ${literal(address + 8)}); ` : '';
    const likely = mnemonic.endsWith('L') && !mnemonic.endsWith('AL');
    return `const taken = ${condition}; ${link}s.branch(taken, ${literal(target)}, ${likely});`;
  }
  const memory: Record<string, [number, boolean]> = {
    LB: [1, true],
    LBU: [1, false],
    LH: [2, true],
    LHU: [2, false],
    LW: [4, true],
    LWU: [4, false],
    LD: [8, true],
  };
  if (memory[mnemonic]) {
    const [size, signed] = memory[mnemonic]!;
    return `s.load(${rt}, ${rs}, ${signedImmediate}, ${size}, ${signed});`;
  }
  const stores: Record<string, number> = { SB: 1, SH: 2, SW: 4, SD: 8 };
  if (stores[mnemonic]) {
    return `s.store(${rt}, ${rs}, ${signedImmediate}, ${stores[mnemonic]});`;
  }
  throw new Diagnostic('MIPS_LOWERING', `VR4300 lowering is not implemented for ${mnemonic}.`);
}

/** Build-time execution helper. This compiler is never part of a browser package. */
export function compileVr4300(
  instruction: Vr4300Instruction,
): (machine: Vr4300Machine, fetchedWord?: number) => void {
  return new Function(
    's',
    'fetchedWord',
    `s.begin(${instruction.address},${instruction.word},fetchedWord); ${lower(instruction)} s.finish();`,
  ) as (machine: Vr4300Machine, fetchedWord?: number) => void;
}

function idleLoopAddresses(instructions: readonly Vr4300Instruction[]): number[] {
  return [
    ...new Set(
      instructions
        .filter((i) => i.word === 0x1000ffff)
        .flatMap((i) => [i.address, (i.address + 4) >>> 0]),
    ),
  ].sort((a, b) => a - b);
}

function emitVr4300(instructions: readonly Vr4300Instruction[], page?: number) {
  const cases = new Map<number, { word: number; name: string }[]>(),
    functions: string[] = [];
  const unique = [
    ...new Map(
      instructions.map((instruction) => [
        `${instruction.address}:${instruction.word}`,
        instruction,
      ]),
    ).values(),
  ].sort((a, b) => a.address - b.address || a.word - b.word);
  for (const instruction of unique) {
    const name = `at_${instruction.address.toString(16)}_${instruction.word.toString(16)}`;
    functions.push(
      `function ${name}(s, fetchedWord) {\n  // ${hex(instruction.address)}: ${instruction.text}\n  s.begin(${literal(instruction.address)}, ${literal(instruction.word)}, fetchedWord);\n  ${lower(instruction).replaceAll('; ', ';\n  ')}\n  s.finish();\n}`,
    );
    const row = cases.get(instruction.address) ?? [];
    row.push({ word: instruction.word, name });
    cases.set(instruction.address, row);
  }
  // An immutable address needs one guarded function. Only observed word
  // variants need a second lookup. Paged programs use direct word-indexed
  // arrays, avoiding a Map allocation for every original instruction.
  const entry = (rows: { word: number; name: string }[]) =>
    rows.length === 1
      ? rows[0]!.name
      : `new Map([${rows.map((row) => `[${literal(row.word)}, ${row.name}]`).join(',')}])`;
  const table =
    page === undefined
      ? [
          'const program = new Map([',
          ...[...cases].map(([address, rows]) => `  [${address >>> 2}, ${entry(rows)}],`),
          ']);',
        ]
      : [
          'const program = [',
          ...Array.from({ length: 1024 }, (_, offset) => {
            const rows = cases.get(page * 4096 + offset * 4);
            return `  ${rows ? entry(rows) : 'undefined'},`;
          }),
          '];',
        ];
  const javascript = [
    '// Generated by ROM Studio from original VR4300 words. No runtime decoder.',
    "export const architecture = 'mips3-vr4300';",
    `export const idleAddresses = new Set([${idleLoopAddresses(unique).join(',')}]);`,
    ...functions,
    ...table,
    'export function step(s) {',
    '  const word = s.bus.read32(s.pc);',
    page === undefined
      ? '  const entry = program.get(s.pc >>> 2);'
      : '  const entry = program[(s.pc & 4095) >>> 2];',
    "  const operation = typeof entry === 'function' ? entry : entry?.get(word);",
    '  if (!operation) {',
    "    s.gap('uncompiled-instruction', 'This VR4300 word was not included in the static program.');",
    '  }',
    '  operation(s, word);',
    '}',
  ].join('\n');
  return {
    javascript,
    typescript:
      "import type { Vr4300Machine } from '../runtime/vr4300.js';\n" +
      'type Operation = (s: Vr4300Machine, fetchedWord?: number) => void;\n' +
      javascript
        .replace(
          /function (at_[a-f0-9_]+)\(s, fetchedWord\)/g,
          'function $1(s: Vr4300Machine, fetchedWord?: number)',
        )
        .replace(/function (at_[a-f0-9_]+|step)\(s\)/g, 'function $1(s: Vr4300Machine)')
        .replace(
          'const program = new Map([',
          'const program = new Map<number, Operation | ReadonlyMap<number, Operation>>([',
        )
        .replace(
          'const program = [',
          'const program: (Operation | ReadonlyMap<number, Operation> | undefined)[] = [',
        )
        .replace('const idleAddresses = new Set(', 'const idleAddresses = new Set<number>('),
    instructions: unique,
  };
}

export function liftVr4300(instructions: readonly Vr4300Instruction[]) {
  return emitVr4300(instructions);
}

/** Deliver large static CPU programs in source-address pages. Decoding and
 * lowering remain build-time work; each executed word is still guarded. */
export function liftVr4300Pages(instructions: readonly Vr4300Instruction[]) {
  const unique = [...new Map(instructions.map((i) => [`${i.address}:${i.word}`, i])).values()];
  const groups = new Map<number, Vr4300Instruction[]>();
  for (const instruction of unique) {
    const page = instruction.address >>> 12;
    const group = groups.get(page) ?? [];
    group.push(instruction);
    groups.set(page, group);
  }
  const modules: Record<string, { javascript: string; typescript: string }> = {};
  const imports: string[] = [],
    entries: string[] = [];
  for (const [page, group] of [...groups].sort(([a], [b]) => a - b)) {
    const name = (page * 4096).toString(16);
    const program = emitVr4300(group, page);
    modules[`pages/${name}`] = {
      javascript: program.javascript,
      typescript: program.typescript.replace("'../runtime/vr4300.js'", "'../../runtime/vr4300.js'"),
    };
    imports.push(`import { step as page_${name} } from './pages/${name}.js';`);
    entries.push(`[${page}, page_${name}]`);
  }
  const javascript = [
    '// Generated from original VR4300 words; address pages contain static functions.',
    "export const architecture = 'mips3-vr4300';",
    `export const idleAddresses = new Set([${idleLoopAddresses(unique).join(',')}]);`,
    ...imports,
    `const pages = new Map([${entries.join(',')}]);`,
    '// Cache the immutable page function, never an opcode or machine state.',
    'let lastPage = -1, lastStep;',
    'export function step(s) {',
    '  const index = s.pc >>> 12;',
    '  let page = lastStep;',
    '  if (index !== lastPage) { page = pages.get(index); lastPage = index; lastStep = page; }',
    '  if (!page) {',
    '    s.bus.read32(s.pc); // Architectural fetch faults precede coverage diagnostics.',
    "    s.gap('uncompiled-instruction', 'This VR4300 source page was not included.');",
    '  }',
    '  page(s);',
    '}',
  ].join('\n');
  return {
    javascript,
    typescript:
      "import type { Vr4300Machine } from '../runtime/vr4300.js';\n" +
      javascript
        .replace(
          'const pages = new Map(',
          'const pages = new Map<number, (s: Vr4300Machine) => void>(',
        )
        .replace(
          'let lastPage = -1, lastStep;',
          'let lastPage = -1, lastStep: ((s: Vr4300Machine) => void) | undefined;',
        )
        .replace('function step(s)', 'function step(s: Vr4300Machine)')
        .replace('const idleAddresses = new Set(', 'const idleAddresses = new Set<number>('),
    instructions: unique,
    modules,
  };
}
