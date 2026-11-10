import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RspVector, type RspMultiplyKind } from './rsp-vector.js';

test('compiler-selected multiplies match scalar execution across signed edges, selectors and aliases', () => {
  const fail = (detail: string): never => {
    throw Error(detail);
  };
  const actual = new RspVector(fail),
    reference = new RspVector(fail);
  const modes: Record<string, RspMultiplyKind> = {
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
  const edges = [0, 1, 0x7fff, 0x8000, 0xffff, 0xfffe, 2, 0x8001];
  const sums = [2 ** 47 - 1, -(2 ** 47), -1, 0, 1, 2 ** 46, -(2 ** 46), 32768];
  let seed = 0x4d554c;
  for (const [operation, mode] of Object.entries(modes)) {
    for (let element = 0; element < 16; element++) {
      for (const right of [2, 3]) {
        for (const destination of [2, 3, 4]) {
          for (let i = 0; i < actual.registers.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            actual.registers[i] = seed;
          }
          for (let lane = 0; lane < 8; lane++) {
            actual.setLane(2, lane, edges[lane]!);
            actual.setLane(right, lane, edges[(lane + element) & 7]!);
            actual.accumulator[lane] = sums[(lane + element) & 7]!;
          }
          actual.carry = 0xa55a;
          actual.compare = 0x5aa5;
          actual.extension = 0x7f;
          actual.dividerInput = 0x8000;
          actual.dividerOutput = 0x12345678;
          actual.dividerPending = true;
          reference.restore(actual.snapshot());
          actual.multiply(
            mode,
            operation.startsWith('VMAD') || operation === 'VMACF',
            destination,
            2,
            right,
            element,
          );
          reference.execute(operation, destination, 2, right, element);
          assert.deepEqual(
            actual.snapshot(),
            reference.snapshot(),
            `${operation} e${element} vd${destination} vt${right}`,
          );
        }
      }
    }
  }
});

test('48-bit vector accumulators agree with a BigInt oracle across signed products and wrap', () => {
  const vector = new RspVector((detail) => {
    throw new Error(detail);
  });
  const sums = [2n ** 47n - 1n, -(2n ** 47n), -1n, 0n, 1n, 2n ** 46n, -(2n ** 46n), 32768n];
  vector.accumulator.set(sums.map(Number));
  let seed = 0x4e363452;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 65535;
  };
  // Keep the reference in full-width integer arithmetic; the implementation
  // uses exact binary64 integers and explicit signed-48-bit wrapping.
  const product = {
    VMADL: (a: bigint, b: bigint) => (a * b) >> 16n,
    VMADM: (a: bigint, b: bigint) => BigInt.asIntN(16, a) * b,
    VMADN: (a: bigint, b: bigint) => a * BigInt.asIntN(16, b),
    VMADH: (a: bigint, b: bigint) => (BigInt.asIntN(16, a) * BigInt.asIntN(16, b)) << 16n,
    VMACF: (a: bigint, b: bigint) => BigInt.asIntN(16, a) * BigInt.asIntN(16, b) * 2n,
  };
  const operations = Object.keys(product) as (keyof typeof product)[];
  for (let iteration = 0; iteration < 2000; iteration++) {
    const operation = operations[iteration % operations.length]!;
    for (let lane = 0; lane < 8; lane++) {
      const a = random(),
        b = random();
      vector.setLane(1, lane, a);
      vector.setLane(2, lane, b);
      sums[lane] = BigInt.asIntN(48, sums[lane]! + product[operation](BigInt(a), BigInt(b)));
    }
    vector.execute(operation, 3, 1, 2, 0);
    for (let lane = 0; lane < 8; lane++) {
      const value = sums[lane]!,
        upper = value >> 16n;
      const result =
        operation === 'VMADL' || operation === 'VMADN'
          ? upper < -32768n
            ? 0n
            : upper > 32767n
              ? 65535n
              : value & 65535n
          : upper < -32768n
            ? -32768n
            : upper > 32767n
              ? 32767n
              : upper;
      assert.equal(BigInt(vector.accumulator[lane]!), value);
      assert.equal(vector.lane(3, lane), Number(BigInt.asUintN(16, result)));
    }
  }
  assert.deepEqual(
    vector.snapshot().accumulator,
    sums.map((value) => BigInt.asUintN(48, value).toString(16).padStart(12, '0')),
  );
});

test('all vector selectors preserve snapshot operands when either input aliases the destination', () => {
  const fail = (detail: string): never => {
    throw Error(detail);
  };
  const actual = new RspVector(fail),
    independent = new RspVector(fail);
  let seed = 0x525350;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const operations = [
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
  ];
  for (const operation of operations) {
    for (let element = 0; element < 16; element++) {
      for (const destination of [2, 3, 4]) {
        for (const sharedInputs of [false, true]) {
          for (let i = 0; i < actual.registers.length; i++) {
            actual.registers[i] = next();
          }
          actual.accumulator.set(Array.from({ length: 8 }, () => (next() - 0x80000000) * 65536));
          actual.carry = next() & 65535;
          actual.compare = next() & 65535;
          actual.extension = next() & 255;
          actual.dividerInput = next() & 65535;
          actual.dividerOutput = next() | 0;
          actual.dividerPending = !!(next() & 1);
          const right = sharedInputs ? 2 : 3;
          independent.restore(actual.snapshot());
          // The comparison always writes a separate register and reads immutable
          // copies. VS keeps its low three bits for reciprocal destination lanes.
          independent.registers.set(actual.registers.subarray(16, 24), 10 * 8);
          independent.registers.set(actual.registers.subarray(right * 8, right * 8 + 8), 11 * 8);
          independent.registers.set(
            actual.registers.subarray(destination * 8, destination * 8 + 8),
            20 * 8,
          );
          const before = actual.registers.slice();
          actual.execute(operation, destination, 2, right, element);
          independent.execute(operation, 20, 10, 11, element);
          assert.deepEqual(
            actual.registers.subarray(destination * 8, destination * 8 + 8),
            independent.registers.subarray(20 * 8, 21 * 8),
            `${operation} e${element} vd${destination}`,
          );
          before.set(
            actual.registers.subarray(destination * 8, destination * 8 + 8),
            destination * 8,
          );
          assert.deepEqual(actual.registers, before);
          assert.deepEqual(
            { ...actual.snapshot(), registers: [] },
            { ...independent.snapshot(), registers: [] },
          );
        }
      }
    }
  }
});
