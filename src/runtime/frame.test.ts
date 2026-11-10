import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameClock, type RecoveryGap } from './frame.js';
import { Machine } from './mos6502.js';

/** A deterministic stand-in for translated code and boundary services: each
 * instruction costs 2–7 cycles and mutates registers; every 97 cycles a
 * boundary service (like an interrupt entry) runs instead of an instruction. */
function host() {
  const machine = new Machine({ read: () => 0, write: () => {}, peek: () => 0 });
  let nextService = 97;
  return {
    machine,
    outcome: undefined as undefined,
    gap: undefined as RecoveryGap | undefined,
    services: 0,
    boundary() {
      if (machine.cycles >= nextService) {
        nextService += 97;
        this.services++;
        machine.pc = 0xfe00 + (this.services & 0xff);
        machine.cycles += 7;
        return true;
      }
      return false;
    },
    step(m: Machine) {
      m.a = (m.a * 5 + m.pc + 1) & 255;
      m.x = (m.x + m.a) & 255;
      m.pc = (m.pc + 1 + (m.a & 3)) & 0xffff;
      m.cycles += 2 + (m.a % 6);
      m.instructions++;
    },
  };
}

test('Desk stepping one operation at a time matches uninterrupted frames', () => {
  const frames = 40,
    cycles = 1000;
  const a = host(),
    b = host();
  const clockA = new FrameClock(0),
    clockB = new FrameClock(0);
  for (let frame = 0; frame < frames; frame++) {
    assert.equal(clockA.advance(a, cycles), true);
  }
  let operations = 0;
  while (clockB.frames < frames) {
    let asked = false;
    clockB.advance(b, cycles, undefined, () => {
      const stop = asked;
      asked = true;
      return stop;
    });
    operations++;
  }
  assert.ok(operations > frames * 100, 'stepping must have paused inside frames');
  for (const key of ['a', 'x', 'pc', 'cycles', 'instructions'] as const) {
    assert.equal(b.machine[key], a.machine[key], key);
  }
  assert.equal(b.services, a.services);
  assert.equal(clockB.frames, clockA.frames);
});

test('a breakpoint stop leaves the frame open and resuming completes it', () => {
  const a = host(),
    clock = new FrameClock(0);
  const completed = clock.advance(a, 1000, undefined, (m) => m.instructions === 25);
  assert.equal(completed, false);
  assert.equal(a.machine.instructions, 25);
  assert.equal(clock.frames, 0);
  assert.equal(clock.advance(a, 1000), true);
  assert.equal(clock.frames, 1);
  assert.ok(a.machine.cycles >= 1000 && a.machine.cycles < 1010);
});
