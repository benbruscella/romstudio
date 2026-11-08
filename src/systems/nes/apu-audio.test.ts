import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NesApu } from './apu.js';
import { NesAudio } from './apu-audio.js';
import { NES_PAL_CPU_HZ } from './timing.js';

function tone() {
  const apu = new NesApu();
  apu.write(0x4017, 0x40);
  apu.write(0x4015, 1);
  apu.write(0x4000, 0xbf); // 50% pulse, halted length, constant volume 15.
  apu.write(0x4001, 8);
  apu.write(0x4002, 235);
  apu.write(0x4003, 0);
  return apu;
}

test('host output has exact sample counts and no initial held-DAC pop', () => {
  const apu = new NesApu(),
    audio = new NesAudio(apu, 48000);
  apu.onClock = audio.tick;
  apu.advanceTo(NES_PAL_CPU_HZ);
  const values = audio.take();
  assert.equal(values.length, 48000);
  assert.ok(values.every((value) => Math.abs(value) < 1e-10));
  assert.equal(audio.take().length, 0);
  assert.throws(() => new NesAudio(apu, 0));
});

test('pulse frequency follows PAL CPU division and output remains finite without clipping', () => {
  const apu = tone(),
    audio = new NesAudio(apu, 48000);
  apu.onClock = audio.tick;
  apu.advanceTo(NES_PAL_CPU_HZ);
  const values = audio.take();
  let crossings = 0,
    peak = 0;
  for (let index = 4800; index < values.length; index++) {
    const value = values[index]!;
    assert.ok(Number.isFinite(value));
    peak = Math.max(peak, Math.abs(value));
    if (values[index - 1]! <= 0 && value > 0) {
      crossings++;
    }
  }
  const expected = NES_PAL_CPU_HZ / (16 * 236);
  assert.ok(Math.abs(crossings / 0.9 - expected) < 2);
  assert.ok(peak > 0.05 && peak < 1);
});

test('audio collection boundaries and disabled output do not alter chip state or samples', () => {
  const whole = tone(),
    split = tone(),
    muted = tone();
  const a = new NesAudio(whole, 44100),
    b = new NesAudio(split, 44100);
  whole.onClock = a.tick;
  split.onClock = b.tick;
  whole.advanceTo(100000);
  split.advanceTo(12345);
  const first = b.take();
  split.advanceTo(100000);
  const second = b.take();
  const combined = new Float32Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  assert.deepEqual(combined, a.take());
  muted.advanceTo(100000);
  assert.deepEqual(whole.snapshot(), split.snapshot());
  assert.deepEqual(whole.snapshot(), muted.snapshot());
});
