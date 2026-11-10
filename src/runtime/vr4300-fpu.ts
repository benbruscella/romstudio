import {
  binary32,
  binary64,
  finiteBinary,
  roundBinary,
  roundInteger,
  sqrtBinary,
  type BinaryFormat,
  type FiniteBinary,
  type FloatRounding,
  type RoundedBinary,
} from './binary-float.js';
import { registerWords, lowRegisterWord, highRegisterWord } from './register-words.js';

const singleConditions = new Map(
  [
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
  ].map((name, index) => [`C.${name}.S`, index]),
);
const integerModes = new Map<string, FloatRounding>([
  ['ROUND.W.S', 0],
  ['TRUNC.W.S', 1],
  ['CEIL.W.S', 2],
  ['FLOOR.W.S', 3],
]);
const normalSingle = new Set(['ADD.S', 'SUB.S', 'MUL.S', 'ABS.S', 'NEG.S']);
const normalOrZero = (word: number) => {
  const exponent = (word >>> 23) & 255;
  return (exponent > 0 && exponent < 255) || (word & 0x7fffffff) === 0;
};

export interface Vr4300FpuOptions {
  /** The retained BigInt arithmetic path is an independent numerical reference
   * and handles rounding modes/operands outside the guarded native path. */
  nativeSingle?: boolean;
}

/** Raw CP1 register layout. With FR=0 an odd word register addresses the high
 * half of its preceding even register. This layout is independent of the
 * big-endian memory order used by LDC1/SDC1. */
export class Vr4300Fpu {
  readonly registers = new BigUint64Array(32);
  private readonly words = registerWords(this.registers);
  private readonly single = new Float32Array(1);
  private readonly singleBits = new Uint32Array(this.single.buffer);
  readonly executionStats = { nativeSingle: 0, exact: 0 };
  control = 0;

  constructor(
    private readonly status: () => number,
    private readonly unavailable: () => never,
    private readonly unsupported: (detail: string) => never,
    private readonly exception: (detail: string) => never,
    private readonly options: Readonly<Vr4300FpuOptions> = {},
  ) {}

  private require(): void {
    if ((this.status() & 0x20000000) === 0) {
      this.unavailable();
    }
  }

  word(index: number): number {
    this.require();
    const paired = (this.status() & 0x04000000) === 0;
    const physical = paired ? index & ~1 : index;
    const word = paired && (index & 1) !== 0 ? highRegisterWord : lowRegisterWord;
    return this.words[physical * 2 + word]!;
  }

  setWord(index: number, value: number): void {
    this.require();
    const paired = (this.status() & 0x04000000) === 0;
    const physical = paired ? index & ~1 : index;
    const word = paired && (index & 1) !== 0 ? highRegisterWord : lowRegisterWord;
    this.words[physical * 2 + word] = value >>> 0;
  }

  private doubleIndex(index: number): number {
    this.require();
    if ((this.status() & 0x04000000) === 0 && (index & 1) !== 0) {
      this.unsupported('A doubleword CP1 access needs an even register when FR=0.');
    }
    return index;
  }

  doubleword(index: number): bigint {
    return this.registers[this.doubleIndex(index)]!;
  }

  setDoubleword(index: number, value: bigint): void {
    this.registers[this.doubleIndex(index)] = BigInt.asUintN(64, value);
  }

  get condition(): boolean {
    this.require();
    return (this.control & 0x800000) !== 0;
  }

  private flags(flags: number): void {
    this.control = (this.control & ~0x3f000) | (flags << 12);
    const enabled = (this.control >>> 7) & 31;
    this.control |= (flags & ~enabled) << 2;
    if ((flags & enabled) !== 0) {
      this.exception('Enabled floating-point exception.');
    }
  }

  private unimplemented(detail: string): never {
    this.control = (this.control & ~0x3f000) | 0x20000;
    return this.exception(detail);
  }

  private format(name: string): BinaryFormat {
    if (name === 'S') {
      return binary32;
    }
    if (name === 'D') {
      return binary64;
    }
    return this.unsupported(`Floating-point format ${name} is not implemented.`);
  }

  private bits(index: number, format: string): bigint {
    return format === 'S' || format === 'W' ? BigInt(this.word(index)) : this.doubleword(index);
  }

  private setBits(index: number, format: string, bits: bigint): void {
    if (format === 'S' || format === 'W') {
      this.setWord(index, Number(BigInt.asUintN(32, bits)));
    } else {
      this.setDoubleword(index, bits);
    }
  }

  private value(index: number, name: string): FiniteBinary {
    const bits = this.bits(index, name);
    if (name === 'W' || name === 'L') {
      return {
        numerator: BigInt.asIntN(name === 'W' ? 32 : 64, bits),
        exponent: 0,
        negativeZero: false,
      };
    }
    const format = this.format(name);
    const value = finiteBinary(bits, format);
    if (!value) {
      return this.unsupported('Arithmetic with NaN or infinity operands is not yet implemented.');
    }
    const magnitude = value.numerator < 0n ? -value.numerator : value.numerator;
    if (magnitude !== 0n && magnitude < 1n << BigInt(format.fractionBits)) {
      return this.unimplemented('VR4300 arithmetic with a denormal operand.');
    }
    return value;
  }

  private result(
    index: number,
    name: string,
    rounded: RoundedBinary,
    rounding: FloatRounding,
  ): void {
    let flags = Number(rounded.inexact) | (rounded.overflow ? 4 : 0);
    let bits = rounded.bits;
    if (rounded.underflow) {
      if ((this.control & 0x01000000) === 0 || (this.control & 0xa00) !== 0) {
        this.unimplemented('VR4300 underflow requires a software exception with this FCSR.');
      }
      const format = this.format(name);
      const signMask = 1n << BigInt(format.fractionBits + format.exponentBits);
      const negative = (bits & signMask) !== 0n;
      const awayFromZero = (rounding === 2 && !negative) || (rounding === 3 && negative);
      bits = (bits & signMask) | (awayFromZero ? 1n << BigInt(format.fractionBits) : 0n);
      flags |= 3;
    }
    this.flags(flags);
    this.setBits(index, name, bits);
  }

  execute(instruction: string, destination: number, left: number, right: number): void {
    this.require();
    if (
      this.options.nativeSingle !== false &&
      this.fastSingle(instruction, destination, left, right)
    ) {
      this.executionStats.nativeSingle++;
      return;
    }
    this.executionStats.exact++;
    const parts = instruction.split('.'),
      operation = parts[0]!;
    const conversion = ['CVT', 'ROUND', 'TRUNC', 'CEIL', 'FLOOR'].includes(operation);
    const name = parts[conversion || operation === 'C' ? 2 : 1]!;
    const rounding = (this.control & 3) as FloatRounding;
    if (operation === 'MOV') {
      this.setBits(destination, name, this.bits(left, name));
      return;
    }
    const a = this.value(left, name);
    if (conversion) {
      const target = parts[1]!;
      if (target === 'W' || target === 'L') {
        const mode =
          ({ ROUND: 0, TRUNC: 1, CEIL: 2, FLOOR: 3 } as Record<string, FloatRounding>)[operation] ??
          rounding;
        const result = roundInteger(a.numerator, a.exponent, mode);
        const width = target === 'W' ? 32 : 64;
        const valid = result.value === BigInt.asIntN(width, result.value);
        this.flags(valid ? Number(result.inexact) : 16);
        this.setBits(destination, target, valid ? result.value : (1n << BigInt(width - 1)) - 1n);
      } else {
        this.result(
          destination,
          target,
          roundBinary(a.numerator, 1n, a.exponent, this.format(target), rounding, a.negativeZero),
          rounding,
        );
      }
      return;
    }
    if (operation === 'ABS' || operation === 'NEG') {
      const bits = this.bits(left, name),
        format = this.format(name);
      const sign = 1n << BigInt(format.fractionBits + format.exponentBits);
      this.flags(0);
      this.setBits(destination, name, operation === 'NEG' ? bits ^ sign : bits & ~sign);
      return;
    }
    const format = this.format(name);
    if (operation === 'SQRT') {
      if (a.numerator < 0n) {
        this.flags(16);
        this.setBits(destination, name, name === 'S' ? 0x7fbfffffn : 0x7ff7ffffffffffffn);
      } else {
        this.result(destination, name, sqrtBinary(a, format, rounding), rounding);
      }
      return;
    }
    const b = this.value(right, name);
    const commonExponent = Math.min(a.exponent, b.exponent);
    const leftInteger = a.numerator << BigInt(a.exponent - commonExponent);
    const rightInteger = b.numerator << BigInt(b.exponent - commonExponent);
    if (operation === 'C') {
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
      ].indexOf(parts[1]!);
      if (condition < 0) {
        this.unsupported(`Unknown floating-point comparison ${instruction}.`);
      }
      const result =
        ((condition & 4) !== 0 && leftInteger < rightInteger) ||
        ((condition & 2) !== 0 && leftInteger === rightInteger);
      this.flags(0);
      this.control = result ? this.control | 0x800000 : this.control & ~0x800000;
      return;
    }
    let numerator: bigint,
      denominator = 1n,
      exponent: number;
    let negativeZero: boolean;
    if (operation === 'ADD' || operation === 'SUB') {
      numerator = operation === 'ADD' ? leftInteger + rightInteger : leftInteger - rightInteger;
      exponent = commonExponent;
      const aNegative = a.numerator < 0n || a.negativeZero;
      const bNegative = (b.numerator < 0n || b.negativeZero) !== (operation === 'SUB');
      negativeZero = numerator === 0n && (aNegative === bNegative ? aNegative : rounding === 3);
    } else if (operation === 'MUL') {
      numerator = a.numerator * b.numerator;
      exponent = a.exponent + b.exponent;
      negativeZero = (a.numerator < 0n || a.negativeZero) !== (b.numerator < 0n || b.negativeZero);
    } else if (operation === 'DIV') {
      const negative =
        (a.numerator < 0n || a.negativeZero) !== (b.numerator < 0n || b.negativeZero);
      if (b.numerator === 0n) {
        this.flags(a.numerator === 0n ? 16 : 8);
        const sign = negative ? 1n << BigInt(format.fractionBits + format.exponentBits) : 0n;
        this.setBits(
          destination,
          name,
          a.numerator === 0n
            ? name === 'S'
              ? 0x7fbfffffn
              : 0x7ff7ffffffffffffn
            : sign | (((1n << BigInt(format.exponentBits)) - 1n) << BigInt(format.fractionBits)),
        );
        return;
      }
      numerator = b.numerator < 0n ? -a.numerator : a.numerator;
      denominator = b.numerator < 0n ? -b.numerator : b.numerator;
      exponent = a.exponent - b.exponent;
      negativeZero = negative;
    } else {
      return this.unsupported(`Floating-point operation ${instruction} is not implemented.`);
    }
    this.result(
      destination,
      name,
      roundBinary(numerator, denominator, exponent, format, rounding, negativeZero),
      rounding,
    );
  }

  /** Commit only exact binary64 intermediates followed by one binary32
   * rounding. Tiny/overflow results and other rounding modes keep the general
   * integer-significand implementation. flags() still runs before the write,
   * so enabled exceptions preserve the original destination. */
  private nearestSingle(destination: number, value: number): boolean {
    if (value !== 0 && Math.abs(value) < 2 ** -126) {
      return false;
    }
    this.single[0] = value;
    const rounded = this.single[0]!;
    if (!Number.isFinite(rounded)) {
      return false;
    }
    const bits = this.singleBits[0]!;
    this.flags(value === rounded ? 0 : 1);
    this.setWord(destination, bits);
    return true;
  }

  private fastSingle(
    instruction: string,
    destination: number,
    left: number,
    right: number,
  ): boolean {
    if (instruction === 'MOV.S') {
      this.setWord(destination, this.word(left));
      return true; // MOV preserves FCSR, including pending cause bits.
    }
    if (instruction === 'CVT.S.W') {
      return !(this.control & 3) && this.nearestSingle(destination, this.word(left) | 0);
    }
    const condition = singleConditions.get(instruction),
      integerMode = instruction === 'CVT.W.S' ? this.control & 3 : integerModes.get(instruction);
    if (condition === undefined && integerMode === undefined && !normalSingle.has(instruction)) {
      return false;
    }
    const aWord = this.word(left);
    if (!normalOrZero(aWord)) {
      return false;
    }
    this.singleBits[0] = aWord;
    const a = this.single[0]!;
    if (integerMode !== undefined) {
      const lower = Math.floor(a),
        fraction = a - lower;
      const value =
        integerMode === 1
          ? Math.trunc(a)
          : integerMode === 2
            ? Math.ceil(a)
            : integerMode === 3
              ? lower
              : fraction < 0.5
                ? lower
                : fraction > 0.5
                  ? lower + 1
                  : lower % 2 === 0
                    ? lower
                    : lower + 1;
      if (value < -0x80000000 || value > 0x7fffffff) {
        return false;
      }
      this.flags(value === a ? 0 : 1);
      this.setWord(destination, value >>> 0);
      return true;
    }
    if (instruction === 'ABS.S' || instruction === 'NEG.S') {
      this.flags(0);
      this.setWord(destination, instruction === 'ABS.S' ? aWord & 0x7fffffff : aWord ^ 0x80000000);
      return true;
    }
    const bWord = this.word(right);
    if (!normalOrZero(bWord)) {
      return false;
    }
    this.singleBits[0] = bWord;
    const b = this.single[0]!;
    if (condition !== undefined) {
      const result = !!((condition & 4 && a < b) || (condition & 2 && a === b));
      this.flags(0);
      this.control = result ? this.control | 0x800000 : this.control & ~0x800000;
      return true;
    }
    if (this.control & 3) {
      return false;
    }
    if (instruction === 'MUL.S') {
      // Two 24-bit significands produce at most 48 significant bits. Their
      // product is exact in binary64; no intermediate rounding is discarded.
      return this.nearestSingle(destination, a * b);
    }
    const signedB = instruction === 'SUB.S' ? -b : b,
      sum = a + signedB;
    // TwoSum detects information lost in the binary64 addition. A nonzero
    // residual falls back instead of hiding it from the guest's Inexact flag.
    const approximateB = sum - a,
      residual = a - (sum - approximateB) + (signedB - approximateB);
    return residual === 0 && this.nearestSingle(destination, sum);
  }

  snapshot() {
    return Array.from(this.registers, (value) => value.toString(16).padStart(16, '0'));
  }
  restore(state: ReturnType<Vr4300Fpu['snapshot']>): void {
    this.registers.set(state.map((value) => BigInt('0x' + value)));
  }
}
