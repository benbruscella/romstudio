import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vr4300Fpu } from './vr4300-fpu.js';

test('guarded native single operations match exact BigInt arithmetic, flags, aliases and traps', () => {
  let status = 0x24000000,
    seed = 0x866c72d7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const fail = (detail = 'unavailable'): never => {
    throw Error(detail);
  };
  const fast = new Vr4300Fpu(
      () => status,
      () => fail(),
      fail,
      fail,
    ),
    exact = new Vr4300Fpu(
      () => status,
      () => fail(),
      fail,
      fail,
      { nativeSingle: false },
    );
  const edges = [
    0, 0x80000000, 1, 0x80000001, 0x007fffff, 0x00800000, 0x80800000, 0x3f800000, 0xbf800000,
    0x3f800001, 0x3fc00000, 0xbfc00000, 0x4effffff, 0x4f000000, 0xcf000000, 0x7f7fffff, 0xff7fffff,
    0x7f800000, 0xff800000, 0x7fc00000, 0x7fbfffff,
  ];
  const operations = [
    'ADD.S',
    'SUB.S',
    'MUL.S',
    'DIV.S',
    'SQRT.S',
    'ABS.S',
    'NEG.S',
    'MOV.S',
    'CVT.S.W',
    'CVT.W.S',
    'ROUND.W.S',
    'TRUNC.W.S',
    'CEIL.W.S',
    'FLOOR.W.S',
    ...[
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
    ].map((c) => 'C.' + c + '.S'),
    'ADD.D',
    'MUL.D',
    'CVT.S.L',
  ];
  const outcome = (fpu: Vr4300Fpu, operation: string, destination: number) => {
    let error: string | undefined;
    try {
      fpu.execute(operation, destination, 1, 2);
    } catch (e) {
      error = (e as Error).message;
    }
    return { error, control: fpu.control, registers: fpu.snapshot() };
  };
  for (let i = 0; i < 10000; i++) {
    status = 0x20000000 | (i & 4 ? 0x04000000 : 0);
    const a = i % 3 ? next() : edges[next() % edges.length]!,
      b = i % 3 ? next() : edges[next() % edges.length]!,
      operation = operations[i % operations.length]!,
      destination = [0, 1, 2, 3][(i >>> 3) % 4]!,
      control =
        (i & 16 ? 0x800000 : 0) | (i & 3) | ((i % 5 === 0 ? next() & 31 : 0) << 7) | 0x20004;
    for (const fpu of [fast, exact]) {
      fpu.registers.fill(0x0123456789abcdefn);
      fpu.control = control;
      fpu.setWord(1, a);
      fpu.setWord(2, b);
    }
    assert.deepEqual(
      outcome(fast, operation, destination),
      outcome(exact, operation, destination),
      `case ${i}: ${operation}`,
    );
  }
  assert.ok(fast.executionStats.nativeSingle > 100);
  assert.ok(fast.executionStats.exact > 100);
  assert.equal(exact.executionStats.nativeSingle, 0);
});

test('wide-exponent sums and tiny products retain exact fallback and enabled exceptions preserve destinations', () => {
  const fail = (detail = 'unavailable'): never => {
    throw Error(detail);
  };
  const fpu = new Vr4300Fpu(
    () => 0x24000000,
    () => fail(),
    fail,
    fail,
  );
  fpu.setWord(1, 0x3f800000);
  fpu.setWord(2, 0x0d800000);
  fpu.execute('ADD.S', 3, 1, 2);
  assert.equal(fpu.word(3), 0x3f800000);
  assert.equal((fpu.control >>> 12) & 31, 1);
  assert.equal(fpu.executionStats.exact, 1);
  fpu.control = 0;
  fpu.setWord(1, 0x00800000);
  fpu.setWord(2, 0x3f000000);
  assert.throws(() => fpu.execute('MUL.S', 3, 1, 2));
  assert.equal(fpu.executionStats.exact, 2);
  fpu.setWord(1, 0x3f800001);
  fpu.setWord(2, 0x3f800001);
  fpu.setWord(3, 0xdeadbeef);
  fpu.control = 0x80;
  assert.throws(() => fpu.execute('MUL.S', 3, 1, 2), /Enabled floating-point exception/);
  assert.equal(fpu.word(3), 0xdeadbeef);
  assert.equal(fpu.control & 0x1004, 0x1000);
});
