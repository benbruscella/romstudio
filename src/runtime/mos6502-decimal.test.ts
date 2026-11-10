import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, RamBus } from './mos6502.js';

const packed = (number: number): number => Math.floor(number / 10) * 16 + (number % 10);
test('NMOS decimal results and carry match integer arithmetic for every valid BCD pair and carry', () => {
  const s = new Machine(new RamBus());
  for (let a = 0; a < 100; a++) {
    for (let b = 0; b < 100; b++) {
      for (const carry of [0, 1]) {
        s.a = packed(a);
        s.p = 0x2c | carry;
        s.adc(packed(b));
        assert.equal(s.a, packed((a + b + carry) % 100));
        assert.equal(!!(s.p & 1), a + b + carry >= 100);
        assert.equal(s.p & 12, 12);
        s.a = packed(a);
        s.p = 0x2c | carry;
        s.sbc(packed(b));
        const difference = a - b - (1 - carry);
        assert.equal(s.a, packed((difference + 100) % 100));
        assert.equal(!!(s.p & 1), difference >= 0);
        assert.equal(s.p & 12, 12);
      }
    }
  }
});
test('NMOS decimal flags use binary zero and the documented intermediate carry, including invalid digits', () => {
  const s = new Machine(new RamBus());
  const add = (a: number, b: number, carry: number, result: number, flags: number): void => {
    s.a = a;
    s.p = 0x28 | carry;
    s.adc(b);
    assert.equal(s.a, result);
    assert.equal(s.p & 0xc3, flags);
  };
  add(0x79, 0, 1, 0x80, 0xc0);
  add(0x50, 0x50, 0, 0, 0xc1);
  add(0x80, 0x80, 0, 0x60, 0x43);
  add(0x99, 1, 0, 0, 0x81);
  add(0x0f, 0x0b, 0, 0x10, 0);
  add(0x0f, 0x0f, 0, 0x14, 0);
  for (const [a, b, carry, expected] of [
    [0, 1, 1, 0x99],
    [0x80, 1, 1, 0x79],
    [0, 0x99, 0, 0],
    [0x10, 0x0f, 1, 0x0b],
  ]) {
    const binary = new Machine(new RamBus());
    binary.a = a!;
    binary.p = 0x20 | carry!;
    binary.sbc(b!);
    s.a = a!;
    s.p = 0x28 | carry!;
    s.sbc(b!);
    assert.equal(s.a, expected);
    assert.equal(s.p & 0xc3, binary.p & 0xc3);
  }
});
