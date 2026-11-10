import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../../memory.js';
import { Machine } from '../../runtime/mos6502.js';
import { C64SystemBus } from './system.js';
import { VicII } from './vic.js';
import { Cia6526 } from './cia.js';

test('screen clear erases exactly 1000 characters and colours, homes the editor, and returns to its caller', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    s = new Machine(bus);
  bus.write(0x286, 7);
  bus.bytes.fill(0x41, 0x400, 0x800);
  bus.colour.fill(9);
  s.pc = 0xe544;
  s.p = 0x64;
  s.push(0x80);
  s.push(0x02);
  const initialSp = s.sp;
  assert.equal(bus.boundary(s), true);
  assert.equal(s.pc, 0x8003);
  assert.equal(s.sp, (initialSp + 2) & 255);
  assert.ok(bus.bytes.subarray(0x400, 0x7e8).every((b) => b === 32));
  assert.ok(bus.bytes.subarray(0x7e8, 0x800).every((b) => b === 0x41));
  assert.ok(bus.colour.subarray(0, 1000).every((b) => b === 7));
  assert.ok(bus.colour.subarray(1000).every((b) => b === 9));
  assert.deepEqual([s.a, s.x, s.y, s.p], [0xd8, 1, 0x84, 0xe5]);
  assert.deepEqual(
    [
      bus.read(0xd1),
      bus.read(0xd2),
      bus.read(0xd3),
      bus.read(0xd5),
      bus.read(0xd6),
      bus.read(0xf3),
      bus.read(0xf4),
    ],
    [0, 4, 0, 39, 0, 0, 0xd8],
  );
  for (let row = 0; row <= 25; row++) {
    assert.equal(bus.read(0xd9 + row), 0x84 + Math.floor((row * 40) / 256));
  }
  assert.equal(s.cycles, 37541);
  assert.equal(s.instructions, 8747);
});
test('VIC raster rolls over PAL frames, mirrors registers, and latches/acknowledges masked IRQs', () => {
  const v = new VicII();
  v.write(0x12, 1);
  v.advance(63);
  assert.equal(v.read(0x12), 1);
  assert.equal(v.irq, false);
  v.write(0x1a, 1);
  assert.equal(v.irq, true);
  assert.equal(v.read(0x19) & 0x81, 0x81);
  v.write(0x19, 1);
  assert.equal(v.irq, false);
  v.advance(63 * 255);
  assert.equal(v.read(0x11) & 128, 128);
  assert.equal(v.read(0x12), 0);
  v.advance(63 * 56);
  assert.equal(v.raster, 0);
  v.write(0x60, 3);
  assert.equal(v.read(0x20), 0xf3);
});
test('CIA timers reload and latch interrupts until read; SPACE respects port directions', () => {
  const c = new Cia6526(0xdc00);
  c.write(4, 2);
  c.write(5, 0);
  c.write(13, 129);
  c.write(14, 17);
  c.advance(2);
  assert.equal(c.irq, false);
  c.advance(1);
  assert.equal(c.irq, true);
  assert.equal(c.read(4), 2);
  assert.equal(c.read(13), 129);
  assert.equal(c.irq, false);
  c.advance(6);
  assert.equal(c.irq, true);
  assert.equal(c.read(1), 255);
  c.space = true;
  assert.equal(c.read(1), 239);
  c.write(0, 255);
  assert.equal(c.read(1), 255);
  c.write(0, 0);
  c.write(2, 0);
  assert.equal(c.read(1), 255);
});

test('a joystick switch pulls a CIA pin low even when its direction is output', () => {
  const c = new Cia6526(0xdc00);
  c.write(0, 255);
  c.write(2, 255);
  c.inputA = 239;
  assert.equal(c.read(0), 239);
  assert.equal(c.registers[0], 255);
  c.inputA = 255;
  assert.equal(c.read(0), 255);
  c.write(0, 0);
  c.write(2, 0);
  assert.equal(c.read(0), 255);
});

test('keyboard switches support forward/reverse scanning, release and connected paths', () => {
  const c = new Cia6526(0xdc00);
  c.setKey(3, 3, true);
  c.write(0, 0xf7);
  assert.equal(c.read(1), 0xf7);
  c.write(0, 0xff);
  assert.equal(c.read(1), 0xff);
  c.write(2, 0);
  c.write(3, 255);
  c.write(1, 0xf7);
  assert.equal(c.read(0), 0xf7);
  c.setKey(3, 3, false);
  assert.equal(c.read(0), 255);
  c.setKey(3, 3, true);
  c.setKey(3, 4, true);
  c.setKey(4, 4, true);
  assert.equal(c.read(0), 0xe7);
  assert.throws(() => c.setKey(8, 0, true), /indices/);
});

test('the game can read startup metadata from mapped KERNAL addresses, then bank back to RAM', () => {
  const bus = new C64SystemBus(new AddressSpace());
  bus.write(0xecf1, 0x42);
  assert.equal(bus.read(0xecf1), 40);
  assert.equal(bus.read(0xed08), 192);
  assert.equal(bus.read(0xecca), 0x9b);
  bus.write(1, 0x35);
  assert.equal(bus.read(0xecf1), 0x42);
});

test('the video timing tail returns to its caller and starts the PAL timer', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    s = new Machine(bus);
  s.pc = 0xff5e;
  s.cycles = 1000;
  s.push(0x80);
  s.push(0x02);
  assert.equal(bus.boundary(s), true);
  assert.equal(s.pc, 0x8003);
  assert.equal(bus.read(0x2a6), 1);
  assert.equal(bus.cia1.a.latch, 0x4025);
  assert.ok(bus.cia1.a.control & 1);
  assert.ok(s.cycles >= 63 * 312);
});

test('KERNAL IRQ entry and exit preserve the interrupted registers, flags and stack', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    s = new Machine(bus);
  bus.write(0x314, 0);
  bus.write(0x315, 0x90);
  s.pc = 0x8000;
  s.a = 0x42;
  s.x = 0x21;
  s.y = 0x33;
  s.p = 0x20;
  bus.vic.irqFlags = 1;
  bus.vic.irqMask = 1;
  assert.equal(bus.boundary(s), true);
  assert.equal(s.pc, 0x9000);
  assert.equal(s.sp, 0xf7);
  bus.write(0xd019, 1);
  s.pc = 0xea81;
  assert.equal(bus.boundary(s), true);
  assert.deepEqual([s.pc, s.a, s.x, s.y, s.p, s.sp], [0x8000, 0x42, 0x21, 0x33, 0x20, 0xfd]);
  assert.equal(s.cycles, 58);
});

test('the default keyboard IRQ restores inactive port lines after a paddle probe', () => {
  const bus = new C64SystemBus(new AddressSpace()),
    s = new Machine(bus);
  bus.write(0xdc00, 0x80);
  s.pc = 0xea31;
  assert.equal(bus.boundary(s), true);
  assert.equal(bus.read(0xdc00), 0x7f);
  assert.equal(bus.read(0xc5), 0x40);
  assert.equal(s.pc, 0xea81);
});
