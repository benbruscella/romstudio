import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NesCartridge } from './cartridge.js';
import { NesPpu } from './ppu.js';
const fixture = () =>
  new NesPpu(
    new NesCartridge({
      mapper: 0,
      mirroring: 'vertical',
      prg: new Uint8Array(32768),
      chr: new Uint8Array(),
    }),
  );
test('PPU ports share the scroll/address write latch, buffer VRAM reads and mirror palettes', () => {
  const p = fixture();
  p.writeRegister(5, 17);
  assert.equal(p.fineX, 1);
  assert.equal(p.secondWrite, true);
  p.readRegister(2);
  assert.equal(p.secondWrite, false);
  p.writeRegister(6, 0x20);
  p.writeRegister(6, 0);
  p.writeRegister(7, 42);
  assert.equal(p.readMemory(0x2800), 42);
  p.writeRegister(6, 0x20);
  p.writeRegister(6, 0);
  assert.equal(p.readRegister(7), 0);
  assert.equal(p.readRegister(7), 42);
  p.writeMemory(0x3f10, 33);
  assert.equal(p.readMemory(0x3f00), 33);
  p.writeRegister(6, 0x3f);
  p.writeRegister(6, 0);
  assert.equal(p.readRegister(7), 33);
  p.writeRegister(0, 4);
  p.writeRegister(6, 0x20);
  p.writeRegister(6, 0);
  p.writeRegister(7, 9);
  assert.equal(p.v, 0x2020);
});
test('PAL vblank asserts NMI, status reads clear vblank, and the pre-render line resets hit flags', () => {
  const p = fixture();
  p.writeRegister(0, 128);
  p.tick(241 * 341 + 1);
  assert.equal(p.line, 241);
  assert.ok(p.status & 128);
  assert.equal(p.nmiPending, true);
  assert.ok(p.readRegister(2) & 128);
  assert.equal(p.status & 128, 0);
  p.status |= 96;
  p.tick(70 * 341);
  assert.equal(p.line, 311);
  assert.equal(p.status & 0xe0, 0);
});
for (const behind of [false, true]) {
  test(`sprite/background pixels and sprite-zero hit agree with independent fixture; behind=${behind}`, () => {
    const p = fixture();
    for (let row = 0; row < 8; row++) {
      p.cartridge.writeChr(row, 0x80);
    }
    p.writeMemory(0x3f01, 1);
    p.writeMemory(0x3f11, 2);
    p.oam.set([10, 0, behind ? 32 : 0, 16]);
    p.mask = 0x1e;
    p.tick(341 * 312 + 341 * 12 + 20);
    const at = (11 * 256 + 16) * 4;
    assert.deepEqual(
      [...p.pixels.subarray(at, at + 4)],
      behind ? [0, 42, 136, 255] : [20, 18, 167, 255],
    );
    assert.ok(p.status & 64);
  });
}
