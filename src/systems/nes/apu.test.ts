import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NesApu } from './apu.js';
import { NesEnvelope } from './apu-envelope.js';
import { NesPulse } from './apu-pulse.js';
import { NesTriangle, NesNoise, NesDmc } from './apu-channels.js';

test('pulse duty sequences and timer clocks follow the documented waveform periods', () => {
  const expected = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1],
  ];
  for (let duty = 0; duty < 4; duty++) {
    const pulse = new NesPulse(true);
    pulse.enabled = true;
    pulse.write(0, (duty << 6) | 0x3f, 0);
    pulse.write(1, 8, 0);
    pulse.write(2, 8, 0);
    pulse.write(3, 0, 10);
    pulse.timer = 8;
    const values: number[] = [];
    for (let phase = 0; phase < 8; phase++) {
      values.push(pulse.output / 15);
      for (let clock = 0; clock < 9; clock++) {
        pulse.tick();
      }
    }
    assert.deepEqual(values, expected[duty]);
    assert.equal(pulse.phase, 0);
    pulse.period = 7;
    assert.equal(pulse.output, 0);
  }
});

test('pulse high writes restart phase/envelope but preserve timer; enable never reloads length', () => {
  const apu = new NesApu(),
    pulse = apu.pulses[0];
  apu.write(0x4003, 0x28);
  assert.equal(pulse.length, 0);
  apu.write(0x4015, 1);
  assert.equal(pulse.length, 0);
  pulse.phase = 5;
  pulse.timer = 99;
  apu.write(0x4003, 0x28);
  assert.equal(pulse.length, 4);
  assert.equal(pulse.phase, 0);
  assert.equal(pulse.timer, 99);
  assert.equal(pulse.envelope.restart, true);
  apu.write(0x4015, 0);
  assert.equal(pulse.length, 0);
});

test('sweep has distinct negate adders and mutes overflowing targets even when disabled', () => {
  const first = new NesPulse(true),
    second = new NesPulse(false);
  for (const pulse of [first, second]) {
    pulse.period = 200;
    pulse.sweep = 0x89;
    pulse.halfFrame();
  }
  assert.equal(first.period, 99);
  assert.equal(second.period, 100);
  first.period = 0x600;
  first.sweep = 1;
  assert.equal(first.muted, true);
  first.sweep = 8;
  assert.equal(first.muted, false);
  first.sweep = 0x80;
  first.period = 100;
  first.halfFrame();
  assert.equal(first.period, 100, 'shift zero prevents a sweep update');
});

test('envelope restart, divider, loop and constant-volume selection remain independent', () => {
  const envelope = new NesEnvelope();
  envelope.control = 1;
  envelope.restart = true;
  const values: number[] = [];
  for (let quarter = 0; quarter < 5; quarter++) {
    envelope.clock();
    values.push(envelope.volume);
  }
  assert.deepEqual(values, [15, 15, 14, 14, 13]);
  envelope.control = 0x30;
  for (let quarter = 0; quarter < 14; quarter++) {
    envelope.clock();
  }
  assert.equal(envelope.volume, 0, 'constant zero does not stop internal decay');
  envelope.control = 0x20;
  envelope.decay = 0;
  envelope.divider = 0;
  envelope.clock();
  assert.equal(envelope.volume, 15);
});

test('triangle linear counter gates sequencing while its DAC holds the last value', () => {
  const triangle = new NesTriangle();
  triangle.enabled = true;
  triangle.write(0, 2, 0);
  triangle.write(2, 0, 0);
  triangle.write(3, 0, 10);
  triangle.quarterFrame();
  assert.equal(triangle.linear, 2);
  assert.equal(triangle.reload, false);
  const values = [triangle.output];
  for (let clock = 0; clock < 31; clock++) {
    triangle.tick();
    values.push(triangle.output);
  }
  assert.deepEqual(
    values,
    [
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15,
    ],
  );
  triangle.quarterFrame();
  triangle.quarterFrame();
  assert.equal(triangle.linear, 0);
  triangle.tick();
  assert.equal(triangle.output, 15);
  triangle.control = 0x83;
  triangle.reload = true;
  triangle.quarterFrame();
  triangle.quarterFrame();
  assert.equal(triangle.linear, 3);
  assert.equal(triangle.reload, true);
});

test('noise uses CPU-cycle PAL periods and distinct 15-bit feedback taps', () => {
  const noise = new NesNoise();
  noise.control = 2; // PAL period 14 CPU cycles, not NTSC 16.
  noise.tick();
  assert.equal(noise.shift, 0x4000);
  for (let cycle = 0; cycle < 13; cycle++) {
    noise.tick();
  }
  assert.equal(noise.shift, 0x4000);
  noise.tick();
  assert.equal(noise.shift, 0x2000);
  noise.shift = 0x41;
  noise.timer = 0;
  noise.control = 0;
  noise.tick();
  assert.equal(noise.shift, 0x4020);
  noise.shift = 0x41;
  noise.timer = 0;
  noise.control = 0x80;
  noise.tick();
  assert.equal(noise.shift, 0x20);
});

test('DMC reads LSB first, holds its DAC in silence and raises IRQ at fetch completion', () => {
  const dmc = new NesDmc();
  dmc.write(0, 0x8f);
  dmc.write(1, 64);
  dmc.enable(true);
  assert.equal(dmc.dmaAddress, 0xc000);
  dmc.complete(0x85);
  assert.equal(dmc.irq, true);
  assert.equal(dmc.remaining, 0);
  assert.equal(dmc.level, 64);
  // At PAL rate F each bit clocks every 50 CPU cycles. First drain the
  // empty output shift register, then consume the actual buffered byte.
  const clockBit = () => {
    for (let cycle = 0; cycle < 50; cycle++) {
      dmc.tick();
    }
  };
  for (let bit = 0; bit < 8; bit++) {
    clockBit();
  }
  const levels: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    clockBit();
    levels.push(dmc.level);
  }
  assert.deepEqual(levels, [66, 64, 66, 64, 62, 60, 58, 60]);
  assert.equal(dmc.silent, true);
  clockBit();
  assert.equal(dmc.level, 60);
  dmc.enable(false);
  assert.equal(dmc.level, 60);
  assert.equal(dmc.irq, false);
});

test('DMC wraps cartridge addresses, loops without IRQ and clamps its seven-bit DAC', () => {
  const dmc = new NesDmc();
  dmc.write(0, 0xc0);
  dmc.write(2, 0xff);
  dmc.write(3, 1);
  dmc.enable(true);
  assert.equal(dmc.sampleAddress, 0xffc0);
  assert.equal(dmc.sampleLength, 17);
  dmc.address = 0xffff;
  dmc.remaining = 2;
  dmc.complete(0xff);
  assert.equal(dmc.address, 0x8000);
  dmc.buffer = undefined;
  dmc.complete(0xff);
  assert.equal(dmc.address, 0xffc0);
  assert.equal(dmc.remaining, 17);
  assert.equal(dmc.irq, false);
  dmc.silent = false;
  dmc.shift = 1;
  dmc.level = 126;
  dmc.timer = 0;
  dmc.tick();
  assert.equal(dmc.level, 126);
  dmc.shift = 0;
  dmc.level = 1;
  dmc.timer = 0;
  dmc.tick();
  assert.equal(dmc.level, 1);
});

test('PAL four-step frame divider has independent quarter/half clocks and reasserted IRQ edges', () => {
  const apu = new NesApu();
  apu.advanceTo(8312);
  assert.equal(apu.frame.quarterClocks, 0);
  apu.advanceTo(8313);
  assert.equal(apu.frame.quarterClocks, 1);
  apu.advanceTo(16627);
  assert.equal(apu.frame.quarterClocks, 2);
  assert.equal(apu.frame.halfClocks, 1);
  apu.advanceTo(24939);
  assert.equal(apu.frame.quarterClocks, 3);
  apu.advanceTo(33252);
  assert.equal(apu.readStatus() & 64, 64);
  assert.equal(apu.frame.irq, false);
  apu.advanceTo(33253);
  assert.equal(apu.readStatus() & 64, 64);
  assert.equal(apu.frame.quarterClocks, 4);
  assert.equal(apu.frame.halfClocks, 2);
  apu.advanceTo(33254);
  assert.equal(apu.readStatus() & 64, 64);
  assert.equal(apu.frame.cycle, 0);
});

test('frame reset is delayed 3/4 CPU cycles; five-step mode clocks counters and inhibits IRQ', () => {
  for (const cycle of [0, 1]) {
    const apu = new NesApu();
    apu.advanceTo(cycle);
    apu.write(0x4017, 0xc0);
    const reset = cycle + (cycle ? 4 : 3);
    apu.advanceTo(reset - 1);
    assert.equal(apu.frame.quarterClocks, 0);
    apu.advanceTo(reset);
    assert.equal(apu.frame.quarterClocks, 1);
    assert.equal(apu.frame.halfClocks, 1);
    apu.advanceTo(reset + 41565);
    assert.equal(apu.frame.quarterClocks, 5);
    assert.equal(apu.frame.halfClocks, 3);
    assert.equal(apu.irq, false);
  }
});

test('status reads acknowledge frame IRQ only; channel disable preserves triangle/DMC DAC levels', () => {
  const apu = new NesApu();
  apu.write(0x4015, 15);
  for (const address of [0x4003, 0x4007, 0x400b, 0x400f]) {
    apu.write(address, 0);
  }
  apu.triangle.phase = 5;
  apu.write(0x4011, 73);
  apu.frame.irq = true;
  apu.dmc.irq = true;
  assert.equal(apu.readStatus(), 0xcf);
  assert.equal(apu.frame.irq, false);
  assert.equal(apu.dmc.irq, true);
  apu.write(0x4015, 0);
  assert.equal(apu.readStatus(), 0);
  assert.equal(apu.triangle.output, 10);
  assert.equal(apu.dmc.level, 73);
});
