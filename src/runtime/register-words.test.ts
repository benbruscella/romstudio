import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vr4300Machine, Vr4300Ram, Vr4300Gap, type Vr4300Memory } from './vr4300.js';
import { Vr4300Fpu } from './vr4300-fpu.js';

function randomWords() {
  let state = 0x866c72d7;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}

test('word views preserve full GPR values, direct writes, sign extension and restores', () => {
  const cpu = new Vr4300Machine(new Vr4300Ram(64)),
    next = randomWords();
  for (let i = 0; i < 4000; i++) {
    const index = (i % 31) + 1,
      value = (BigInt(next()) << 32n) | BigInt(next());
    cpu.registers[index] = BigInt.asIntN(64, value);
    assert.equal(cpu.r32(index), Number(BigInt.asIntN(32, value)));
    const word = next();
    cpu.set32(index, word);
    assert.equal(cpu.r(index), BigInt.asIntN(32, BigInt(word)));
    cpu.set32(index, value);
    assert.equal(cpu.r(index), BigInt.asIntN(32, value));
  }
  const state = cpu.snapshot();
  cpu.set64(1, 0x123456789abcdefn);
  cpu.restore(state);
  for (let i = 1; i < 32; i++) {
    assert.equal(cpu.r32(i), Number(BigInt.asIntN(32, cpu.r(i))));
  }
  cpu.registers[0] = -1n;
  assert.equal(cpu.r32(0), 0);
  const before = cpu.r(1);
  for (const invalid of [NaN, Infinity, -Infinity, 1.25]) {
    assert.throws(() => cpu.set32(1, invalid), RangeError);
    assert.equal(cpu.r(1), before);
  }
});

test('CP1 word views preserve paired/full layouts, untouched halves and checkpoint restores', () => {
  const next = randomWords();
  let status = 0x20000000;
  const fail = (detail = 'disabled'): never => {
    throw Error(detail);
  };
  const fpu = new Vr4300Fpu(
    () => status,
    () => fail(),
    fail,
    fail,
  );
  for (const full of [false, true]) {
    status = 0x20000000 | (full ? 0x04000000 : 0);
    for (let i = 0; i < 3000; i++) {
      const index = i % 32,
        physical = full ? index : index & ~1,
        shift = !full && index & 1 ? 32n : 0n,
        value = (BigInt(next()) << 32n) | BigInt(next());
      fpu.registers[physical] = value;
      assert.equal(fpu.word(index), Number((value >> shift) & 0xffffffffn));
      const word = next();
      fpu.setWord(index, word);
      const mask = 0xffffffffn << shift;
      assert.equal(fpu.registers[physical], (value & ~mask) | (BigInt(word) << shift));
    }
    const state = fpu.snapshot(),
      before = fpu.word(5);
    fpu.setWord(5, ~before);
    fpu.restore(state);
    assert.equal(fpu.word(5), before);
  }
});

test('numeric effective addresses match the previous wrapped BigInt width rules', () => {
  let read = -1,
    write = -1,
    stored = 0;
  const bus: Vr4300Memory = {
    read8: () => 255,
    read16: () => 0x8001,
    read32: (address) => {
      read = address;
      return 0x89abcdef;
    },
    read64: () => 0x8000000000000001n,
    write8: () => {},
    write16: () => {},
    write32: (address, value) => {
      write = address;
      stored = value;
    },
    write64: () => {},
  };
  const cpu = new Vr4300Machine(bus),
    next = randomWords();
  cpu.set64(3, 0x12345678abcdef01n);
  const offsets = [-32769, -32768, -1, 0, 1, 32767, 32768, 0x100000000];
  const boundaries = [
    0n,
    -1n,
    0x7fffffffn,
    0x80000000n,
    0xffffffffn,
    -0x80000000n,
    -0x80000001n,
    0x100000000n,
    -0x100000000n,
    0x7fffffffffffffffn,
    -0x8000000000000000n,
  ];
  for (let i = 0; i < 2000; i++) {
    const random =
        i % 3 === 0
          ? BigInt(next())
          : i % 3 === 1
            ? BigInt(next() | 0)
            : (BigInt(next()) << 32n) | BigInt(next()),
      base = BigInt.asIntN(64, i < boundaries.length ? boundaries[i]! : random),
      offset = offsets[i % offsets.length]!;
    cpu.set64(2, base);
    const expected = BigInt.asIntN(64, base + BigInt(offset)),
      valid =
        expected === BigInt.asIntN(32, expected) || (expected >= 0n && expected <= 0xffffffffn);
    if (valid) {
      const address = Number(BigInt.asUintN(32, expected));
      cpu.load(1, 2, offset, 4, true);
      assert.equal(read, address);
      assert.equal(cpu.r(1), BigInt.asIntN(32, 0x89abcdefn));
      cpu.store(3, 2, offset, 4);
      assert.equal(write, address);
      assert.equal(stored, 0xabcdef01);
    } else {
      const width = (error: unknown) =>
        error instanceof Vr4300Gap && error.kind === 'address-width';
      assert.throws(() => cpu.load(1, 2, offset, 4, true), width);
      assert.throws(() => cpu.store(3, 2, offset, 4), width);
    }
  }
  for (const size of [1, 2, 4, 8]) {
    for (const signed of [false, true]) {
      cpu.load(1, 0, 0, size, signed);
      const raw =
        size === 1 ? 255n : size === 2 ? 0x8001n : size === 4 ? 0x89abcdefn : 0x8000000000000001n;
      assert.equal(cpu.r(1), BigInt.asIntN(64, signed ? BigInt.asIntN(size * 8, raw) : raw));
    }
  }
});
