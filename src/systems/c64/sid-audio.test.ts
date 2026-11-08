import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidAudio, PAL_SID_CLOCK } from './sid-audio.js';
import { AddressSpace } from '../../memory.js';
import { C64SystemBus } from './system.js';

function tone(control = 0x21) {
  const registers = new Uint8Array(32),
    frequency = Math.round((440 * 0x1000000) / PAL_SID_CLOCK);
  registers[0] = frequency & 255;
  registers[1] = frequency >>> 8;
  registers[2] = 0;
  registers[3] = 8;
  registers[4] = control;
  registers[6] = 0xf0;
  registers[24] = 15;
  return registers;
}
test('SID frequency and sample count follow the PAL clock; volume zero silences all three voices', () => {
  const sound = new SidAudio(tone(), 0, 48000);
  sound.advanceTo(PAL_SID_CLOCK);
  const samples = sound.take();
  assert.equal(samples.length, 48000);
  const crossings = samples
    .slice(1000)
    .filter((value, index, rest) => index > 0 && value >= 0 && rest[index - 1]! < 0).length;
  assert.ok(Math.abs(crossings - (440 * 47000) / 48000) < 3, String(crossings));
  sound.write(24, 0, PAL_SID_CLOCK);
  sound.advanceTo(PAL_SID_CLOCK * 2);
  assert.ok(
    sound
      .take()
      .slice(-1000)
      .every((value) => Math.abs(value) < 0.00001),
  );
});
test('SID gate release decays to silence; pulse, triangle, noise, filter and voice-three mute remain finite', () => {
  for (const waveform of [0x11, 0x41, 0x81, 0x15, 0x23]) {
    const sound = new SidAudio(tone(waveform), 0);
    sound.advanceTo(10000);
    assert.ok(
      sound.take().some((value) => Math.abs(value) > 0.01),
      `waveform ${waveform}`,
    );
    sound.write(4, waveform & ~1, 10000);
    sound.advanceTo(100000);
    const released = sound.take();
    assert.ok(released.every(Number.isFinite));
    assert.ok(released.slice(-100).every((value) => Math.abs(value) < 0.0001));
  }
  const registers = tone();
  registers[23] = 0xf1;
  registers[24] = 0x7f;
  const filtered = new SidAudio(registers, 0);
  filtered.advanceTo(100000);
  assert.ok(filtered.take().every((value) => Number.isFinite(value) && Math.abs(value) <= 1));
  const third = new Uint8Array(32);
  third.set(tone().subarray(0, 7), 14);
  third[24] = 0x8f;
  const muted = new SidAudio(third, 0);
  muted.advanceTo(10000);
  assert.ok(muted.take().every((value) => value === 0));
});
test('timestamped SID writes preserve short gates within a frame and render independently of chunk boundaries', () => {
  const registers = tone();
  registers[4] = 0x20;
  const a = new SidAudio(registers, 0),
    b = new SidAudio(registers, 0);
  const run = (sound: SidAudio, chunks: boolean) => {
    sound.write(4, 0x21, 1000);
    if (chunks) {
      sound.advanceTo(2000);
    }
    sound.write(4, 0x20, 5000);
    if (chunks) {
      sound.advanceTo(6000);
    }
    sound.advanceTo(19656);
    return sound.take();
  };
  const expected = run(a, false),
    actual = run(b, true);
  assert.ok(expected.some((value) => Math.abs(value) > 0.01));
  assert.equal(actual.length, expected.length);
  for (let sample = 0; sample < actual.length; sample++) {
    assert.ok(Math.abs(actual[sample]! - expected[sample]!) < 0.000001);
  }
  assert.throws(() => a.advanceTo(0), /backwards/);
});
test('SID write observers receive mirrored I/O writes and instruction clock without changing CPU-visible register state', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    writes: number[][] = [];
  bus.write(1, 0x35);
  bus.advanceTo(42);
  bus.sidWriteObserver = (...values) => writes.push(values);
  bus.write(0xd424, 0x21);
  assert.deepEqual(writes, [[4, 0x21, 42]]);
  assert.equal(bus.sid[4], 0x21);
  assert.equal(bus.sidBusValue, 0x21);
  bus.write(1, 0x34);
  bus.write(0xd404, 0xff);
  assert.equal(writes.length, 1);
});
