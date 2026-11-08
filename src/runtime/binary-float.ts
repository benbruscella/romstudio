/** Exact finite binary arithmetic for the MIPS FPU. Integers retain the full
 * significand until the final rounding step, including sticky remainder bits.
 * This avoids rounding through JavaScript's intermediate double precision. */
export interface BinaryFormat {
  fractionBits: number;
  exponentBits: number;
  bias: number;
}
export const binary32: BinaryFormat = { fractionBits: 23, exponentBits: 8, bias: 127 };
export const binary64: BinaryFormat = { fractionBits: 52, exponentBits: 11, bias: 1023 };
export interface FiniteBinary {
  numerator: bigint;
  exponent: number;
  negativeZero: boolean;
}
export type FloatRounding = 0 | 1 | 2 | 3; // nearest-even, zero, +infinity, -infinity

export function finiteBinary(bits: bigint, format: BinaryFormat): FiniteBinary | undefined {
  const { fractionBits, exponentBits, bias } = format;
  const fraction = bits & ((1n << BigInt(fractionBits)) - 1n);
  const exponent = Number((bits >> BigInt(fractionBits)) & ((1n << BigInt(exponentBits)) - 1n));
  if (exponent === (1 << exponentBits) - 1) {
    return undefined;
  }
  const negative = (bits & (1n << BigInt(fractionBits + exponentBits))) !== 0n;
  const significand = exponent === 0 ? fraction : (1n << BigInt(fractionBits)) | fraction;
  return {
    numerator: negative ? -significand : significand,
    exponent: (exponent === 0 ? 1 - bias : exponent - bias) - fractionBits,
    negativeZero: negative && significand === 0n,
  };
}

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

function floorLog2(numerator: bigint, denominator: bigint): number {
  let exponent = bitLength(numerator) - bitLength(denominator);
  const atLeast =
    exponent >= 0
      ? numerator >= denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) >= denominator;
  if (!atLeast) {
    exponent--;
  }
  return exponent;
}

function scale(numerator: bigint, denominator: bigint, exponent: number): [bigint, bigint] {
  return exponent >= 0
    ? [numerator << BigInt(exponent), denominator]
    : [numerator, denominator << BigInt(-exponent)];
}

function roundUp(
  quotient: bigint,
  remainder: bigint,
  denominator: bigint,
  negative: boolean,
  rounding: FloatRounding,
): boolean {
  if (remainder === 0n) {
    return false;
  }
  if (rounding === 1) {
    return false;
  }
  if (rounding === 2) {
    return !negative;
  }
  if (rounding === 3) {
    return negative;
  }
  const twice = remainder * 2n;
  return twice > denominator || (twice === denominator && (quotient & 1n) !== 0n);
}

export function roundInteger(
  numerator: bigint,
  exponent: number,
  rounding: FloatRounding,
): { value: bigint; inexact: boolean } {
  const negative = numerator < 0n;
  const [n, d] = scale(negative ? -numerator : numerator, 1n, exponent);
  let value = n / d;
  const remainder = n % d;
  if (roundUp(value, remainder, d, negative, rounding)) {
    value++;
  }
  return { value: negative ? -value : value, inexact: remainder !== 0n };
}

export interface RoundedBinary {
  bits: bigint;
  inexact: boolean;
  overflow: boolean;
  underflow: boolean;
}

function pack(
  significand: bigint,
  unitExponent: number,
  negative: boolean,
  inexact: boolean,
  format: BinaryFormat,
  rounding: FloatRounding,
): RoundedBinary {
  const { fractionBits, exponentBits, bias } = format;
  const sign = negative ? 1n << BigInt(fractionBits + exponentBits) : 0n;
  const hidden = 1n << BigInt(fractionBits);
  if (significand >= hidden * 2n) {
    significand >>= 1n;
    unitExponent++;
  }
  const exponent = unitExponent + fractionBits;
  if (exponent > bias) {
    const infinity =
      rounding === 0 || (rounding === 2 && !negative) || (rounding === 3 && negative);
    const maxExponent = (1n << BigInt(exponentBits)) - 1n;
    const bits = infinity
      ? maxExponent << BigInt(fractionBits)
      : ((maxExponent - 1n) << BigInt(fractionBits)) | (hidden - 1n);
    return { bits: sign | bits, inexact: true, overflow: true, underflow: false };
  }
  const tiny = significand < hidden;
  const bits = tiny
    ? significand
    : (BigInt(exponent + bias) << BigInt(fractionBits)) | (significand - hidden);
  return {
    bits: sign | bits,
    inexact,
    overflow: false,
    underflow: (tiny && significand !== 0n) || (tiny && inexact),
  };
}

/** Encode numerator / denominator * 2^exponent with exactly one rounding. */
export function roundBinary(
  numerator: bigint,
  denominator: bigint,
  exponent: number,
  format: BinaryFormat,
  rounding: FloatRounding,
  negativeZero = false,
): RoundedBinary {
  if (denominator <= 0n) {
    throw new RangeError('A finite binary denominator must be positive.');
  }
  const negative = numerator < 0n || (numerator === 0n && negativeZero);
  if (numerator === 0n) {
    return {
      bits: negative ? 1n << BigInt(format.fractionBits + format.exponentBits) : 0n,
      inexact: false,
      overflow: false,
      underflow: false,
    };
  }
  const magnitude = numerator < 0n ? -numerator : numerator;
  const exponentOfValue = floorLog2(magnitude, denominator) + exponent;
  const unit = Math.max(
    exponentOfValue - format.fractionBits,
    1 - format.bias - format.fractionBits,
  );
  const [n, d] = scale(magnitude, denominator, exponent - unit);
  let quotient = n / d;
  const remainder = n % d;
  if (roundUp(quotient, remainder, d, negative, rounding)) {
    quotient++;
  }
  return pack(quotient, unit, negative, remainder !== 0n, format, rounding);
}

function integerSqrt(value: bigint): bigint {
  if (value < 2n) {
    return value;
  }
  let estimate = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) {
      return estimate;
    }
    estimate = next;
  }
}

export function sqrtBinary(
  value: FiniteBinary,
  format: BinaryFormat,
  rounding: FloatRounding,
): RoundedBinary {
  if (value.numerator < 0n) {
    throw new RangeError('A finite square root needs a nonnegative value.');
  }
  if (value.numerator === 0n) {
    return roundBinary(0n, 1n, 0, format, rounding, value.negativeZero);
  }
  const exponent = Math.floor((floorLog2(value.numerator, 1n) + value.exponent) / 2);
  const unit = Math.max(exponent - format.fractionBits, 1 - format.bias - format.fractionBits);
  const [n, d] = scale(value.numerator, 1n, value.exponent - unit * 2);
  let quotient = integerSqrt(n / d);
  const inexact = quotient * quotient * d !== n;
  const midpointSquared = (quotient * 2n + 1n) ** 2n * d;
  if (
    inexact &&
    (rounding === 2 ||
      (rounding === 0 &&
        (n * 4n > midpointSquared || (n * 4n === midpointSquared && (quotient & 1n) !== 0n))))
  ) {
    quotient++;
  }
  return pack(quotient, unit, false, inexact, format, rounding);
}
