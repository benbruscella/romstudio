import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Controls } from './input.js';

test('N64 quick taps survive worker messages until real SI polls sample press and release', () => {
  const pad = new N64Controls();
  pad.update({ pressed: ['Enter', 'Space', 'ArrowRight'] });
  pad.update({ pressed: [] });
  assert.deepEqual(pad.sample(), { buttons: 0x9000, stickX: 80, stickY: 0 });
  assert.deepEqual(pad.sample(), { buttons: 0x9000, stickX: 80, stickY: 0 });
  assert.deepEqual(pad.sample(), { buttons: 0, stickX: 0, stickY: 0 });
  pad.update({ pressed: ['Space'] });
  assert.equal(pad.sample().buttons, 0x8000);
  pad.update({ pressed: [] });
  pad.sample();
  assert.equal(pad.sample().buttons, 0);
});

test('N64 held input remains live and analog state changes independently of digital buttons', () => {
  const pad = new N64Controls();
  pad.update({ pressed: ['ShiftLeft', 'KeyJ'], stickX: 42.4, stickY: -150 });
  for (let poll = 0; poll < 10; poll++) {
    assert.deepEqual(pad.sample(), { buttons: 0x2002, stickX: 42, stickY: -80 });
  }
  pad.update({ pressed: ['ShiftLeft', 'KeyJ'], stickX: -100, stickY: 20 });
  assert.deepEqual(pad.sample(), { buttons: 0x2002, stickX: -80, stickY: 20 });
  pad.update({ pressed: [] });
  assert.deepEqual(pad.sample(), { buttons: 0, stickX: 0, stickY: 0 });
});

test('pausing the host releases pending N64 taps without advancing the controller clock', () => {
  const pad = new N64Controls();
  pad.update({ pressed: ['Enter', 'ArrowUp'], stickX: 64 });
  pad.clear();
  assert.equal(pad.polls, 0);
  assert.deepEqual(pad.sample(), { buttons: 0, stickX: 0, stickY: 0 });
});
