import { Diagnostic } from '../core.js';
import type { RspMachine } from '../runtime/rsp.js';
import type { RspMultiplyKind } from '../runtime/rsp-vector.js';
import { decodeVr4300, type Vr4300Instruction } from './vr4300.js';

export interface RspInstruction extends Vr4300Instruction {
  element: number;
}
const vectorOperations: Readonly<Record<number, string>> = {
  0: 'VMULF',
  1: 'VMULU',
  4: 'VMUDL',
  5: 'VMUDM',
  6: 'VMUDN',
  7: 'VMUDH',
  8: 'VMACF',
  9: 'VMACU',
  12: 'VMADL',
  13: 'VMADM',
  14: 'VMADN',
  15: 'VMADH',
  16: 'VADD',
  17: 'VSUB',
  19: 'VABS',
  20: 'VADDC',
  21: 'VSUBC',
  29: 'VSAR',
  32: 'VLT',
  33: 'VEQ',
  34: 'VNE',
  35: 'VGE',
  36: 'VCL',
  37: 'VCH',
  38: 'VCR',
  39: 'VMRG',
  40: 'VAND',
  41: 'VNAND',
  42: 'VOR',
  43: 'VNOR',
  44: 'VXOR',
  45: 'VNXOR',
  48: 'VRCP',
  49: 'VRCPL',
  50: 'VRCPH',
  51: 'VMOV',
  52: 'VRSQ',
  53: 'VRSQL',
  54: 'VRSQH',
  55: 'VNOP',
};
const multiplyKinds: Readonly<Record<string, RspMultiplyKind>> = {
  VMULF: 'fractional',
  VMACF: 'fractional',
  VMUDL: 'unsigned-high',
  VMADL: 'unsigned-high',
  VMUDM: 'signed-unsigned',
  VMADM: 'signed-unsigned',
  VMUDN: 'unsigned-signed',
  VMADN: 'unsigned-signed',
  VMUDH: 'signed-high',
  VMADH: 'signed-high',
};
const vectorLoads = [
  'LBV',
  'LSV',
  'LLV',
  'LDV',
  'LQV',
  'LRV',
  'LPV',
  'LUV',
  'LHV',
  'LFV',
  'LWV',
  'LTV',
];
const transferSizes: Readonly<Record<string, number>> = {
  LBV: 1,
  SBV: 1,
  LSV: 2,
  SSV: 2,
  LLV: 4,
  SLV: 4,
  LDV: 8,
  SDV: 8,
  LQV: 0,
  SQV: 0,
  LRV: -1,
  SRV: -1,
};
const vectorScales = [0, 1, 2, 3, 4, 4, 3, 3, 4, 4, 4, 4];
const imem = (address: number) => '0x' + address.toString(16).padStart(3, '0');
const controlRegisters = [
  'SP_MEM_ADDR',
  'SP_DRAM_ADDR',
  'SP_RD_LEN',
  'SP_WR_LEN',
  'SP_STATUS',
  'SP_DMA_FULL',
  'SP_DMA_BUSY',
  'SP_SEMAPHORE',
  'DPC_START',
  'DPC_END',
  'DPC_CURRENT',
  'DPC_STATUS',
  'DPC_CLOCK',
  'DPC_BUFBUSY',
  'DPC_PIPEBUSY',
  'DPC_TMEM',
];
const supportedScalar = new Set([
  'NOP',
  'SLL',
  'SRL',
  'SRA',
  'SLLV',
  'SRLV',
  'SRAV',
  'ADD',
  'ADDU',
  'SUB',
  'SUBU',
  'AND',
  'OR',
  'XOR',
  'NOR',
  'SLT',
  'SLTU',
  'ADDI',
  'ADDIU',
  'SLTI',
  'SLTIU',
  'ANDI',
  'ORI',
  'XORI',
  'LUI',
  'J',
  'JAL',
  'JR',
  'JALR',
  'BEQ',
  'BNE',
  'BLEZ',
  'BGTZ',
  'BLTZ',
  'BGEZ',
  'BLTZAL',
  'BGEZAL',
  'LB',
  'LBU',
  'LH',
  'LHU',
  'LW',
  'SB',
  'SH',
  'SW',
  'MFC0',
  'MTC0',
  'BREAK',
]);

export function decodeRsp(word: number, address: number): RspInstruction {
  if (address < 0 || address > 0xffc) {
    throw new Diagnostic('RSP_ADDRESS', 'An RSP source address must be inside its 4 KiB IMEM.');
  }
  if (
    !Number.isInteger(word) ||
    word < 0 ||
    word > 0xffffffff ||
    !Number.isInteger(address) ||
    address % 4 !== 0
  ) {
    throw new Diagnostic(
      'RSP_WORD',
      'Expected an aligned RSP address and a 32-bit instruction word.',
    );
  }
  const opcode = word >>> 26,
    rs = (word >>> 21) & 31,
    rt = (word >>> 16) & 31,
    rd = (word >>> 11) & 31,
    shift = (word >>> 6) & 31;
  const element = (word >>> 7) & 15;
  let mnemonic = '',
    text = '',
    offset = (word << 25) >> 25;
  if (opcode === 18 && rs >= 16) {
    mnemonic = vectorOperations[word & 63] ?? '';
    const selector = rs & 15;
    const right =
      `$v${rt}` +
      (selector < 2 ? '' : selector >= 8 ? `[lane ${selector & 7}]` : `[selector ${selector}]`);
    text = mnemonic === 'VNOP' ? mnemonic : `${mnemonic} $v${shift}, $v${rd}, ${right}`;
    if (mnemonic === 'VSAR') {
      text = `VSAR $v${shift}, ACC[${({ 8: 'high', 9: 'middle', 10: 'low' } as Record<number, string>)[selector] ?? 'zero'}]`;
    } else if (['VMOV', 'VRCP', 'VRCPL', 'VRCPH', 'VRSQ', 'VRSQL', 'VRSQH'].includes(mnemonic)) {
      text = `${mnemonic} $v${shift}[lane ${rd & 7}], $v${rt}[${mnemonic === 'VMOV' && selector < 8 ? 'selector ' + selector : 'lane ' + (selector & 7)}]`;
    }
  } else if (opcode === 18 && [0, 2, 4, 6].includes(rs)) {
    mnemonic = ({ 0: 'MFC2', 2: 'CFC2', 4: 'MTC2', 6: 'CTC2' } as Record<number, string>)[rs]!;
    text =
      rs === 2 || rs === 6
        ? `${mnemonic} $${rt}, ${['VCO', 'VCC', 'VCE'][rd] ?? '$' + rd}`
        : `${mnemonic} $${rt}, $v${rd}[byte ${element}]`;
  } else if (opcode === 50 || opcode === 58) {
    const load = vectorLoads[rd];
    if (load) {
      mnemonic = opcode === 50 ? load : 'S' + load.slice(1);
      offset *= 2 ** vectorScales[rd]!;
      text = `${mnemonic} $v${rt}[byte ${element}], ${offset}($${rs})`;
    }
  }
  if (opcode === 18 || opcode === 50 || opcode === 58) {
    if (!mnemonic) {
      throw new Diagnostic(
        'RSP_OPCODE',
        `Unimplemented RSP vector word $${word.toString(16)} at IMEM+$${address.toString(16)}.`,
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
      element: opcode === 18 && rs >= 16 ? rs & 15 : element,
      immediate: word & 65535,
      signedImmediate: offset,
      target: 0,
      mnemonic,
      text,
      bytes: [word >>> 24, (word >>> 16) & 255, (word >>> 8) & 255, word & 255],
    };
  }
  const instruction = decodeVr4300(word, address);
  if (!supportedScalar.has(instruction.mnemonic)) {
    throw new Diagnostic(
      'RSP_OPCODE',
      `RSP operation ${instruction.mnemonic} is not implemented at $${address.toString(16)}.`,
    );
  }
  const target = instruction.target & 0xfff;
  // The word encodes a MIPS jump address, but the RSP exposes only twelve PC
  // bits. Display the same IMEM offset that the generated operation uses.
  text = instruction.text.replace(
    '$' + instruction.target.toString(16).toUpperCase().padStart(8, '0'),
    'IMEM+$' + target.toString(16).toUpperCase().padStart(3, '0'),
  );
  if (instruction.mnemonic === 'MFC0' || instruction.mnemonic === 'MTC0') {
    text = `${instruction.mnemonic} $${rt}, ${controlRegisters[rd] ?? '$' + rd}`;
  }
  return { ...instruction, element: 0, target, text };
}

function lower(i: RspInstruction): string {
  const { rs, rt, rd, shift, immediate, signedImmediate, address, target, mnemonic } = i;
  const a = `s.r(${rs})`,
    b = `s.r(${rt})`;
  if (i.opcode === 18 && rs >= 16) {
    const kind = multiplyKinds[mnemonic];
    if (kind) {
      const accumulate = mnemonic.startsWith('VMAD') || mnemonic === 'VMACF';
      return `s.vector.multiply('${kind}', ${accumulate}, ${shift}, ${rd}, ${rt}, ${i.element});`;
    }
    return `s.vector.execute('${mnemonic}', ${shift}, ${rd}, ${rt}, ${i.element});`;
  }
  if (i.opcode === 50 || i.opcode === 58) {
    const size = transferSizes[mnemonic];
    if (size !== undefined) {
      return `s.transferVector('${mnemonic}', ${i.opcode === 58}, ${rt}, ${rs}, ${signedImmediate}, ${i.element}, ${size});`;
    }
    return `s.vectorMemory('${mnemonic}', ${rt}, ${rs}, ${signedImmediate}, ${i.element});`;
  }
  switch (mnemonic) {
    case 'MFC2':
      return `s.set(${rt}, s.vector.moveFrom(${rd}, ${i.element}));`;
    case 'MTC2':
      return `s.vector.moveTo(${rd}, ${i.element}, s.u(${rt}));`;
    case 'CFC2':
      return `s.set(${rt}, s.vector.readControl(${rd}));`;
    case 'CTC2':
      return `s.vector.writeControl(${rd}, s.u(${rt}));`;
    case 'NOP':
      return '';
    case 'SLL':
      return `s.set(${rd}, ${b} << ${shift});`;
    case 'SRL':
      return `s.set(${rd}, ${b} >>> ${shift});`;
    case 'SRA':
      return `s.set(${rd}, ${b} >> ${shift});`;
    case 'SLLV':
      return `s.set(${rd}, ${b} << (${a} & 31));`;
    case 'SRLV':
      return `s.set(${rd}, ${b} >>> (${a} & 31));`;
    case 'SRAV':
      return `s.set(${rd}, ${b} >> (${a} & 31));`;
    case 'ADD':
    case 'ADDU':
      return `s.set(${rd}, ${a} + ${b});`;
    case 'SUB':
    case 'SUBU':
      return `s.set(${rd}, ${a} - ${b});`;
    case 'AND':
      return `s.set(${rd}, ${a} & ${b});`;
    case 'OR':
      return `s.set(${rd}, ${a} | ${b});`;
    case 'XOR':
      return `s.set(${rd}, ${a} ^ ${b});`;
    case 'NOR':
      return `s.set(${rd}, ~(${a} | ${b}));`;
    case 'SLT':
      return `s.set(${rd}, Number(${a} < ${b}));`;
    case 'SLTU':
      return `s.set(${rd}, Number(s.u(${rs}) < s.u(${rt})));`;
    case 'ADDI':
    case 'ADDIU':
      return `s.set(${rt}, ${a} + ${signedImmediate});`;
    case 'ANDI':
      return `s.set(${rt}, ${a} & ${immediate});`;
    case 'ORI':
      return `s.set(${rt}, ${a} | ${immediate});`;
    case 'XORI':
      return `s.set(${rt}, ${a} ^ ${immediate});`;
    case 'LUI':
      return `s.set(${rt}, ${immediate << 16});`;
    case 'SLTI':
      return `s.set(${rt}, Number(${a} < ${signedImmediate}));`;
    case 'SLTIU':
      return `s.set(${rt}, Number(s.u(${rs}) < ${signedImmediate >>> 0}));`;
    case 'MFC0':
      return `s.set(${rt}, s.bus.readControl(${rd}));`;
    case 'MTC0':
      return `s.bus.writeControl(${rd}, s.u(${rt}));`;
    case 'BREAK':
      return 's.bus.break();';
    case 'J':
      return `s.branch(true, ${imem(target)});`;
    case 'JAL':
      return `s.set(31, ${imem((address + 8) & 0xfff)}); s.branch(true, ${imem(target)});`;
    case 'JR':
      return `s.branch(true, ${a});`;
    case 'JALR':
      return `const target = ${a}; s.set(${rd}, ${(address + 8) & 0xfff}); s.branch(true, target);`;
  }
  if (/^(?:BEQ|BNE|BLEZ|BGTZ|BLTZ|BGEZ)/.test(mnemonic)) {
    const condition =
      mnemonic === 'BEQ'
        ? `${a} === ${b}`
        : mnemonic === 'BNE'
          ? `${a} !== ${b}`
          : mnemonic === 'BLEZ'
            ? `${a} <= 0`
            : mnemonic === 'BGTZ'
              ? `${a} > 0`
              : mnemonic.startsWith('BLTZ')
                ? `${a} < 0`
                : `${a} >= 0`;
    return `const taken = ${condition}; ${mnemonic.endsWith('AL') ? `s.set(31, ${imem((address + 8) & 0xfff)}); ` : ''}s.branch(taken, ${imem(target)});`;
  }
  const sizes: Record<string, number> = {
    LB: 1,
    LBU: 1,
    LH: 2,
    LHU: 2,
    LW: 4,
    SB: 1,
    SH: 2,
    SW: 4,
  };
  if (mnemonic.startsWith('L') && sizes[mnemonic]) {
    return `s.load(${rt}, ${rs}, ${signedImmediate}, ${sizes[mnemonic]}, ${!mnemonic.endsWith('U')});`;
  }
  if (mnemonic.startsWith('S') && sizes[mnemonic]) {
    return `s.store(${rt}, ${rs}, ${signedImmediate}, ${sizes[mnemonic]});`;
  }
  throw new Diagnostic('RSP_LOWERING', `RSP operation ${mnemonic} has no static lowering.`);
}

/** Build-time compiler; browser execution uses only the emitted functions. */
export function compileRsp(
  instruction: RspInstruction,
): (machine: RspMachine, fetchedWord?: number) => void {
  return new Function(
    's',
    'fetchedWord',
    `s.begin(${instruction.address},${instruction.word},fetchedWord); ${lower(instruction)} s.finish();`,
  ) as (machine: RspMachine, fetchedWord?: number) => void;
}

export function liftRsp(instructions: readonly RspInstruction[]) {
  const unique = [...new Map(instructions.map((i) => [`${i.address}:${i.word}`, i])).values()].sort(
    (a, b) => a.address - b.address || a.word - b.word,
  );
  const functions: string[] = [],
    rows = new Map<number, string[]>(),
    localAddresses = new Set<number>();
  const safeLocal = new Set([
    'NOP',
    'SLL',
    'SRL',
    'SRA',
    'SLLV',
    'SRLV',
    'SRAV',
    'ADDU',
    'SUBU',
    'ADDIU',
    'AND',
    'OR',
    'XOR',
    'NOR',
    'SLT',
    'SLTU',
    'SLTI',
    'SLTIU',
    'ANDI',
    'ORI',
    'XORI',
    'LUI',
    'MFC2',
    'MTC2',
    'ADD',
    'SUB',
    'ADDI',
    'LB',
    'LBU',
    'LH',
    'LHU',
    'LW',
    'SB',
    'SH',
    'SW',
    'LBV',
    'LSV',
    'LLV',
    'LDV',
    'LQV',
    'LTV',
    'SBV',
    'SSV',
    'SLV',
    'SDV',
    'SQV',
    'STV',
    'VMULF',
    'VMACF',
    'VMUDL',
    'VMUDM',
    'VMUDN',
    'VMUDH',
    'VMADL',
    'VMADM',
    'VMADN',
    'VMADH',
    'VSAR',
    'VADD',
    'VSUB',
    'VABS',
    'VADDC',
    'VSUBC',
    'VAND',
    'VNAND',
    'VOR',
    'VNOR',
    'VXOR',
    'VNXOR',
    'VCH',
    'VCL',
    'VCR',
    'VLT',
    'VEQ',
    'VNE',
    'VGE',
    'VMRG',
    'VMOV',
    'VRCP',
    'VRCPL',
    'VRCPH',
    'VRSQ',
    'VRSQL',
    'VRSQH',
    'VNOP',
  ]);
  const branches = new Set([
    'J',
    'JAL',
    'JR',
    'JALR',
    'BEQ',
    'BNE',
    'BLEZ',
    'BGTZ',
    'BLTZ',
    'BGEZ',
    'BLTZAL',
    'BGEZAL',
  ]);
  for (const instruction of unique) {
    const name = `at_${instruction.address.toString(16)}_${instruction.word.toString(16)}`;
    let policy = 'BARRIER',
      check = '',
      wait = '';
    if (
      safeLocal.has(instruction.mnemonic) ||
      (['LRV', 'SRV'].includes(instruction.mnemonic) && instruction.element === 0) ||
      (['CFC2', 'CTC2'].includes(instruction.mnemonic) && instruction.rd < 3)
    ) {
      policy = 'LOCAL';
      localAddresses.add(instruction.address);
    }
    if (branches.has(instruction.mnemonic)) {
      policy = 'BRANCH';
    }
    if (instruction.mnemonic === 'MFC0' && [4, 5, 6, 10, 11].includes(instruction.rd)) {
      policy = 'STABLE_READ';
    }
    if (['LPV', 'LUV', 'SPV', 'SUV'].includes(instruction.mnemonic) && instruction.element === 0) {
      policy = 'PACKED';
      check = `, check: s => ((s.r(${instruction.rs}) + ${instruction.signedImmediate}) & 7) === 0`;
    }
    if (
      policy === 'STABLE_READ' &&
      unique.some((i) => i.address === ((instruction.address + 8) & 4095) && i.word === 0)
    ) {
      const loopBranches = unique.filter(
        (i) =>
          i.address === ((instruction.address + 4) & 4095) &&
          (i.mnemonic === 'BEQ' || i.mnemonic === 'BNE') &&
          i.rs === instruction.rt &&
          i.rt === 0 &&
          i.target === instruction.address,
      );
      if (loopBranches.length) {
        wait = `, wait: {register: ${instruction.rd}, destination: ${instruction.rt}, branches: new Map([${loopBranches.map((i) => `[${i.word}, ${i.mnemonic === 'BEQ'}]`).join(',')}])}`;
      }
    }
    functions.push(
      `function ${name}(s, fetchedWord) {\n  // IMEM $${instruction.address.toString(16).toUpperCase().padStart(3, '0')}: ${instruction.text}\n  s.begin(${imem(instruction.address)}, 0x${instruction.word.toString(16).padStart(8, '0')}, fetchedWord);\n  ${lower(instruction).replaceAll('; ', ';\n  ')}\n  s.finish();\n}`,
    );
    const row = rows.get(instruction.address) ?? [];
    row.push(
      `[${instruction.word}, {word: ${instruction.word}, execute: ${name}, policy: ${policy}${check}${wait}}]`,
    );
    rows.set(instruction.address, row);
  }
  const linearStarts = [...localAddresses].filter((address) =>
    [4, 8, 12].every((offset) => localAddresses.has((address + offset) & 4095)),
  );
  const javascript = [
    "export const architecture = 'n64-rsp';",
    ...functions,
    '// Static instruction effects: device writes and unknown operations are barriers.',
    'const BARRIER = 0, LOCAL = 1, BRANCH = 2, STABLE_READ = 3, PACKED = 4;',
    'const program = [',
    ...Array.from({ length: 1024 }, (_, i) => {
      const variants = rows.get(i * 4);
      return `  ${variants ? `new Map([${variants.join(',')}])` : 'undefined'},`;
    }),
    '];',
    '// Remember only the last recovered variant. Always fetch and compare the',
    '// actual IMEM word: DMA and another machine may select a different one.',
    'const lastEntries = new Array(1024);',
    'function entryAt(address, word) {',
    '  const index = address >>> 2, previous = lastEntries[index];',
    '  if (previous?.word === word) return previous;',
    '  return (lastEntries[index] = program[index]?.get(word));',
    '}',
    'export function step(s) {',
    '  const word = s.bus.instruction(s.pc), entry = entryAt(s.pc, word);',
    "  if (!entry) s.gap('uncompiled-instruction', 'This RSP instruction word was not included in the static program.');",
    '  entry.execute(s, word);',
    '}',
    '// Bounded execution of original static operations, including safe branches.',
    '// No decoder, speculative execution, device writes or runtime compilation.',
    'export function runLocal(s, limit, stableReads = false, pureFetch = false) {',
    '  if (!Number.isSafeInteger(limit) || limit < 1) return 0;',
    '  const maximum = Math.min(limit, 256);',
    '  let count = 0;',
    '  while (count < maximum) {',
    '    const word = s.bus.instruction(s.pc), entry = entryAt(s.pc, word);',
    '    if (!entry || !(entry.policy === LOCAL || (entry.policy === BRANCH && !s.inBranchDelaySlot) || (entry.policy === STABLE_READ && stableReads) || (entry.policy === PACKED && entry.check?.(s)))) break;',
    '    const wait = entry.wait, remaining = maximum - count;',
    '    if (wait && stableReads && pureFetch && remaining >= 3 && !s.inBranchDelaySlot && s.nextPc === ((s.pc + 4) & 4095)) {',
    '      const branchWord = s.bus.instruction((s.pc + 4) & 4095), zero = wait.branches.get(branchWord);',
    '      if (zero !== undefined && s.bus.instruction((s.pc + 8) & 4095) === 0) {',
    '        const value = s.bus.readControl(wait.register);',
    '        if (((wait.destination ? value : 0) === 0) === zero) {',
    '          const instructions = remaining - remaining % 3;',
    '          s.set(wait.destination, value); s.advanceControlWait(instructions); count += instructions; continue;',
    '        }',
    '      }',
    '    }',
    '    entry.execute(s, word);',
    '    count++;',
    '  }',
    '  return count;',
    '}',
    `const linearStarts = new Set([${linearStarts.join(',')}]);`,
    'export function prepareLinear(s, limit) {',
    '  if (!Number.isSafeInteger(limit) || limit < 4 || !linearStarts.has(s.pc) || s.nextPc !== ((s.pc + 4) & 4095)) return;',
    '  const operations = [];',
    '  let pc = s.pc;',
    '  while (operations.length < Math.min(limit, 64)) {',
    '    const entry = entryAt(pc, s.bus.instruction(pc));',
    '    if (!entry || entry.policy !== LOCAL) break;',
    '    operations.push(entry.execute);',
    '    pc = (pc + 4) & 4095;',
    '  }',
    '  if (operations.length < 4) return;',
    '  return { instructions: operations.length, execute() { for (const operation of operations) operation(s); } };',
    '}',
  ].join('\n');
  return {
    javascript,
    typescript:
      "import type { RspMachine } from '../runtime/rsp.js';\n" +
      'type Operation = (s: RspMachine, fetchedWord?: number) => void;\n' +
      'type ControlWait = {register: number; destination: number; branches: ReadonlyMap<number, boolean>};\n' +
      'type Entry = {wait?: ControlWait; word: number; execute: Operation; policy: number; check?: (s: RspMachine) => boolean};\n' +
      javascript
        .replace(
          /function (at_[a-f0-9_]+)\(s, fetchedWord\)/g,
          'function $1(s: RspMachine, fetchedWord?: number)',
        )
        .replace('function step(s)', 'function step(s: RspMachine)')
        .replace(
          'function entryAt(address, word)',
          'function entryAt(address: number, word: number)',
        )
        .replace(
          'const lastEntries = new Array(1024);',
          'const lastEntries: (Entry | undefined)[] = new Array(1024);',
        )
        .replace(
          'function runLocal(s, limit, stableReads = false, pureFetch = false)',
          'function runLocal(s: RspMachine, limit: number, stableReads = false, pureFetch = false)',
        )
        .replace(
          /function (prepareLinear|runLocal)\(s, limit\)/g,
          'function $1(s: RspMachine, limit: number)',
        )
        .replace(
          'const program = [',
          'const program: (ReadonlyMap<number, Entry> | undefined)[] = [',
        )
        .replaceAll('new Map([', 'new Map<number, Entry>([')
        .replaceAll('branches: new Map<number, Entry>([', 'branches: new Map<number, boolean>([')
        .replace('const operations = [];', 'const operations: Operation[] = [];')
        .replace('const linearStarts = new Set(', 'const linearStarts = new Set<number>('),
    instructions: unique,
  };
}
