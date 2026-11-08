/** The RSP normalizes a magnitude, indexes a 512-entry ROM and restores its
 * exponent. This is the console's approximation, rather than floating-point
 * division. The ROM's 17-bit significands follow floor(2^26 / (512 + index));
 * the first entry saturates to 0x1FFFF. See the RSP chapter for provenance. */
export function rspReciprocal(input: number): number {
  input |= 0;
  if (input === 0) {
    return 0x7fffffff;
  }
  if (input === -32768) {
    return 0xffff0000;
  }
  // Small negative inputs use two's-complement magnitude; wider negative
  // inputs use one's complement. The result is complemented in either case.
  const negative = input < 0;
  const magnitude = negative ? (input > -32768 ? -input : ~input >>> 0) : input;
  const leading = Math.clz32(magnitude);
  const normalized = (magnitude * 2 ** leading) >>> 0;
  const index = (normalized >>> 22) & 511;
  const significand = Math.min(0x1ffff, Math.floor(2 ** 26 / (512 + index)));
  const result = Math.floor((significand * 2 ** 14) / 2 ** (31 - leading));
  return (negative ? ~result : result) >>> 0;
}

/** Reconstruct the documented square-root ROM's 17-bit significands with
 * exact integer comparisons. The two banks encode exponent parity. This is
 * the published hardware data's quantization, not host floating-point sqrt.
 * All 512 values are checked against Dillonb/n64-resources/rsp.md. */
export const rspSquareRootSignificands = Uint32Array.from({ length: 512 }, (_, index) => {
  const denominator = index < 256 ? 256 + index : 512 + (index - 256) * 2;
  let lower = 65536,
    upper = 131071;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (middle * middle * denominator <= 2 ** 42) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return lower;
});

export function rspReciprocalSquareRoot(input: number): number {
  input |= 0;
  if (input === 0) {
    return 0x7fffffff;
  }
  if (input === -32768) {
    return 0xffff0000;
  }
  const negative = input < 0;
  const magnitude = negative ? (input > -32768 ? -input : ~input >>> 0) : input;
  const leading = Math.clz32(magnitude);
  const normalized = (magnitude * 2 ** leading) >>> 0;
  const index = ((normalized >>> 23) & 255) | (((leading + 1) & 1) << 8);
  const significand = rspSquareRootSignificands[index]!;
  const result = Math.floor((significand * 2 ** 14) / 2 ** Math.floor((31 - leading) / 2));
  return (negative ? ~result : result) >>> 0;
}
