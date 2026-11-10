import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binary32,
  binary64,
  finiteBinary,
  roundBinary,
  roundInteger,
  sqrtBinary,
} from './binary-float.js';

test('finite binary rounding handles ties, sticky bits, signs and all rounding directions', () => {
  const numerator = (1n << 24n) + 1n;
  assert.equal(roundBinary(numerator, 1n, -24, binary32, 0).bits, 0x3f800000n);
  assert.equal(roundBinary(numerator, 1n, -24, binary32, 2).bits, 0x3f800001n);
  assert.equal(roundBinary(-numerator, 1n, -24, binary32, 2).bits, 0xbf800000n);
  assert.equal(roundBinary(-numerator, 1n, -24, binary32, 3).bits, 0xbf800001n);
  assert.equal(roundBinary((1n << 60n) + (1n << 36n) + 1n, 1n, 0, binary32, 0).bits, 0x5d800001n);
  assert.deepEqual(roundInteger(-5n, -1, 0), { value: -2n, inexact: true });
  assert.deepEqual(roundInteger(-7n, -1, 0), { value: -4n, inexact: true });
  assert.deepEqual(roundInteger(-5n, -1, 1), { value: -2n, inexact: true });
});

test('binary division and square root round once in single and double precision', () => {
  assert.equal(roundBinary(1n, 3n, 0, binary32, 0).bits, 0x3eaaaaabn);
  assert.equal(roundBinary(1n, 3n, 0, binary64, 0).bits, 0x3fd5555555555555n);
  assert.equal(
    sqrtBinary({ numerator: 2n, exponent: 0, negativeZero: false }, binary32, 0).bits,
    0x3fb504f3n,
  );
  assert.equal(
    sqrtBinary({ numerator: 2n, exponent: 0, negativeZero: false }, binary64, 0).bits,
    0x3ff6a09e667f3bcdn,
  );
  assert.equal(
    sqrtBinary({ numerator: 4n, exponent: 0, negativeZero: false }, binary64, 0).inexact,
    false,
  );
  assert.equal(
    sqrtBinary({ numerator: 0n, exponent: 0, negativeZero: true }, binary32, 0).bits,
    0x80000000n,
  );
});

test('binary encoding preserves subnormal bits and reports overflow and tiny results', () => {
  assert.deepEqual(roundBinary(1n, 1n, -149, binary32, 0), {
    bits: 1n,
    inexact: false,
    overflow: false,
    underflow: true,
  });
  assert.deepEqual(roundBinary(1n, 1n, -150, binary32, 0), {
    bits: 0n,
    inexact: true,
    overflow: false,
    underflow: true,
  });
  assert.equal(roundBinary(1n, 1n, 128, binary32, 0).bits, 0x7f800000n);
  assert.equal(roundBinary(1n, 1n, 128, binary32, 1).bits, 0x7f7fffffn);
  assert.equal(roundBinary(-1n, 1n, 128, binary32, 2).bits, 0xff7fffffn);
  assert.equal(roundBinary(1n, 1n, 1024, binary64, 0).overflow, true);
  assert.equal(finiteBinary(0x7ff0000000000000n, binary64), undefined);
});

test('exact finite arithmetic agrees with independent IEEE host results across deterministic operands', () => {
  const view = new DataView(new ArrayBuffer(8));
  let seed = 0x12345678;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const format of [binary32, binary64]) {
    const encode = (value: number) => {
      if (format === binary32) {
        view.setFloat32(0, value, false);
        return BigInt(view.getUint32(0, false));
      }
      view.setFloat64(0, value, false);
      return view.getBigUint64(0, false);
    };
    const decode = (bits: bigint) => {
      if (format === binary32) {
        view.setUint32(0, Number(bits), false);
        return view.getFloat32(0, false);
      }
      view.setBigUint64(0, bits, false);
      return view.getFloat64(0, false);
    };
    for (let index = 0; index < 100; index++) {
      const aBits = encode((next() / 2 ** 30 - 2) * 2 ** ((next() % 160) - 80));
      const bBits = encode((next() / 2 ** 30 - 2) * 2 ** ((next() % 160) - 80));
      const a = finiteBinary(aBits, format)!,
        b = finiteBinary(bBits, format)!;
      const exponent = Math.min(a.exponent, b.exponent);
      const sum =
        (a.numerator << BigInt(a.exponent - exponent)) +
        (b.numerator << BigInt(b.exponent - exponent));
      assert.equal(
        roundBinary(sum, 1n, exponent, format, 0).bits,
        encode(decode(aBits) + decode(bBits)),
        `sum ${index}`,
      );
      assert.equal(
        roundBinary(a.numerator * b.numerator, 1n, a.exponent + b.exponent, format, 0).bits,
        encode(decode(aBits) * decode(bBits)),
        `product ${index}`,
      );
      const sign = b.numerator < 0n ? -1n : 1n;
      assert.equal(
        roundBinary(a.numerator * sign, b.numerator * sign, a.exponent - b.exponent, format, 0)
          .bits,
        encode(decode(aBits) / decode(bBits)),
        `division ${index}`,
      );
    }
  }
});
