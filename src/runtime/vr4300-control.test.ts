import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vr4300Control } from './vr4300-control.js';

const control = () =>
  new Vr4300Control((detail) => {
    throw new Error(detail);
  });

test('CP0 Count wraps at half the CPU clock and Compare acknowledges the timer interrupt', () => {
  const cp0 = control();
  cp0.write(9, 0xfffffffe);
  cp0.write(11, 0);
  cp0.advance(3);
  assert.equal(cp0.read(9), 0xffffffff);
  assert.equal(cp0.read(13) & 0x8000, 0);
  cp0.advance(1);
  assert.equal(cp0.read(9), 0);
  assert.equal(cp0.read(13) & 0x8000, 0x8000);
  cp0.write(11, 20);
  assert.equal(cp0.read(13) & 0x8000, 0);
  cp0.write(13, 0xffffffff);
  assert.equal(cp0.read(13), 0x300);
  cp0.write(15, 0);
  assert.equal(cp0.read(15), 0xb22);
});

test('TLB writes preserve paired global bits, probes respect ASIDs and reads restore registers', () => {
  const cp0 = control();
  cp0.write(0, 3);
  cp0.write(2, 0x12347);
  cp0.write(3, 0x56786); // One G bit is clear: this pair is not global.
  cp0.write(5, 0);
  cp0.write(10, 0x00400012);
  cp0.writeTlb();
  cp0.probeTlb();
  assert.equal(cp0.read(0), 3);
  cp0.write(10, 0x00400013);
  cp0.probeTlb();
  assert.equal(cp0.read(0), 0x80000000);
  cp0.write(0, 3);
  cp0.readTlb();
  assert.equal(cp0.read(10), 0x00400012);
  assert.equal(cp0.read(2) & 1, 0);
  assert.equal(cp0.read(3) & 1, 0);
  cp0.write(2, 7);
  cp0.write(3, 7);
  cp0.writeTlb();
  cp0.write(10, 0x00400013);
  cp0.probeTlb();
  assert.equal(cp0.read(0), 3);
  cp0.write(6, 30);
  cp0.advance(3);
  assert.ok(cp0.read(1) >= 30);
});
