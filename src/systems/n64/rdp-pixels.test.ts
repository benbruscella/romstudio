import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Memory } from './memory.js';
import {
  decodeRdpDepth,
  encodeRdpDepth,
  rdpPerspectiveCoordinate,
  type RdpColor,
} from './rdp-pixels.js';
import type { RdpFragment } from './rdp-triangle.js';

function fixture() {
  const m = new N64Memory(new Uint8Array(0)),
    d = m.display;
  d.colorImage = { format: 0, size: 2, width: 4, address: 0x100 };
  d.stateWords[120] = 0xfcffffff;
  d.stateWords[121] = 0xfffe793c; // Shade passes directly in both cycles.
  const p: RdpFragment = { x: 1, y: 1, coverage: 8, shade: [255, 0, 0, 255], dz: 0 };
  return { m, d, p };
}

test('RDP perspective handles positive scale and saturates zero/negative W instead of stopping', () => {
  assert.equal(rdpPerspectiveCoordinate(64, 16384), 128);
  assert.equal(rdpPerspectiveCoordinate(-64, 16384), -128);
  assert.equal(rdpPerspectiveCoordinate(-64, 0), 32767);
  assert.equal(rdpPerspectiveCoordinate(64, -1), 32767);
  assert.equal(rdpPerspectiveCoordinate(32000, 1), 32767);
  assert.equal(rdpPerspectiveCoordinate(-32000, 1), -32768);
});

test('RDP depth compression preserves exponent boundaries and declared quantization', () => {
  const cases = [
    [0, 0],
    [0x1ffff, 0x1ffc],
    [0x20000, 0x2000],
    [0x30000, 0x4000],
    [0x38000, 0x6000],
    [0x3c000, 0x8000],
    [0x3e000, 0xa000],
    [0x3f000, 0xc000],
    [0x3f800, 0xe000],
    [0x3ffff, 0xfffc],
  ];
  for (const [z, packed] of cases) {
    assert.equal(encodeRdpDepth(z!), packed);
    assert.ok(decodeRdpDepth(packed!) <= z!);
  }
  assert.equal(decodeRdpDepth(0x1ffc), 0x1ffc0);
  assert.equal(encodeRdpDepth(-1), 0);
  assert.equal(encodeRdpDepth(999999), 0xfffc);
});

test('RDP combiner follows texture/shade multiplication and separate alpha muxes', () => {
  const { d } = fixture();
  d.stateWords[120] = 0xfc127e24;
  d.stateWords[121] = 0xfffff9fc;
  assert.deepEqual(
    d.pixels.combine([128, 64, 255, 255], [255, 128, 64, 128], 0),
    [128, 32, 64, 128],
  );
  d.stateWords[120] = 0xfcffffff;
  d.stateWords[121] = 0xfffe793c;
  assert.deepEqual(d.pixels.combine([0, 0, 0, 0], [10, 20, 30, 40], 0), [10, 20, 30, 40]);
});

test('combiner register caches follow direct writes and restore while returning owned colors', () => {
  const { d } = fixture();
  d.stateWords[120] = 0xfc30b261;
  d.stateWords[121] = 0x44664924;
  d.stateWords[117] = 0x12345678;
  const texel: RdpColor = [255, 255, 255, 255],
    shade: RdpColor = [0, 0, 0, 0];
  const first = d.pixels.combine(texel, shade, 0),
    saved = d.snapshot();
  assert.deepEqual(first, [0x12, 0x34, 0x56, 0x78]);
  first.fill(0);
  assert.deepEqual(d.pixels.combine(texel, shade, 0), [0x12, 0x34, 0x56, 0x78]);
  d.stateWords[117] = 0x76543210;
  assert.deepEqual(d.pixels.combine(texel, shade, 0), [0x76, 0x54, 0x32, 0x10]);
  d.restore(saved);
  assert.deepEqual(d.pixels.combine(texel, shade, 0), [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(texel, [255, 255, 255, 255]);
  assert.deepEqual(shade, [0, 0, 0, 0]);
});

test('RDP opaque depth writes reject a farther fragment and preserve neighboring bytes', () => {
  const { m, d, p } = fixture();
  m.ram.bytes.fill(0x33, 0x100, 0x120);
  m.ram.write16(0x20a, 0xfffc);
  d.stateWords[125] = 0x200;
  d.modeLow = 0x30;
  p.depth = 100;
  assert.equal(d.pixels.write(d, p, 0), true);
  assert.equal(m.ram.read16(0x10a), 0xf801);
  const stored = m.ram.read16(0x20a);
  assert.equal(decodeRdpDepth(stored), 768); // 800 is quantized to a 64-unit step.
  p.depth = 200;
  p.shade = [0, 255, 0, 255];
  assert.equal(d.pixels.write(d, p, 0), false);
  assert.equal(m.ram.read16(0x10a), 0xf801);
  assert.equal(m.ram.read16(0x20a), stored);
  assert.equal(m.ram.read16(0x108), 0x3333);
  assert.equal(m.ram.read16(0x10c), 0x3333);
});

test('RDP forced alpha blending reads the framebuffer and alpha threshold can suppress writes', () => {
  const { m, d, p } = fixture();
  m.ram.write16(0x10a, 0x003f);
  d.modeLow = 0x00404000; // Pixel*alpha + memory*(1-alpha).
  p.shade = [255, 0, 0, 128];
  d.pixels.write(d, p, 0);
  const value = m.ram.read16(0x10a);
  assert.equal(value >>> 11, 16);
  assert.equal((value >>> 1) & 31, 15);
  d.modeLow = 1;
  d.stateWords[0x39 * 2 + 1] = 200;
  p.shade = [0, 255, 0, 100];
  assert.equal(d.pixels.write(d, p, 0), false);
  assert.equal(m.ram.read16(0x10a), value);
});

test('RDP hidden coverage and depth-delta bits survive independent checkpoints', () => {
  const { d } = fixture();
  d.pixels.hidden[123] = 2;
  d.pixels.hidden[345] = 3;
  const state = d.pixels.snapshot(),
    other = fixture();
  other.d.pixels.restore(state);
  d.pixels.hidden[123] = 0;
  assert.equal(other.d.pixels.hidden[123], 2);
  assert.equal(other.d.pixels.hidden[345], 3);
  assert.throws(() => other.d.pixels.restore({ ...state, hidden: btoa('short') }), /wrong size/);
});
