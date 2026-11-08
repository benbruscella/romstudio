import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readN64Rom } from './n64.js';

test('all N64 dump byte orders normalize to the same unchanged cartridge bytes', () => {
  const original = new Uint8Array(0x1000);
  original.set([0x80, 0x37, 0x12, 0x40]);
  original.set([0x80, 0x24, 0x18, 0], 8);
  original.set([...new TextEncoder().encode('SUPER MARIO 64      ')], 0x20);
  original.set([...new TextEncoder().encode('NSMP')], 0x3b);
  for (const mask of [0, 1, 3]) {
    const dump = Uint8Array.from(original, (_, index) => original[index ^ mask]!);
    const before = dump.slice();
    const result = readN64Rom(dump);
    assert.deepEqual(result.rom, original);
    assert.deepEqual(dump, before);
    assert.equal(result.header.title, 'SUPER MARIO 64');
    assert.equal(result.header.gameCode, 'NSMP');
    assert.equal(result.header.countryCode, 'P');
    assert.equal(result.header.entryPoint, 0x80241800);
  }
});

test('N64 parsing rejects a truncated boot area and partial words', () => {
  const bytes = new Uint8Array(0x1001);
  bytes.set([0x80, 0x37, 0x12, 0x40]);
  assert.throws(() => readN64Rom(bytes), /word-aligned/);
  assert.throws(() => readN64Rom(bytes.subarray(0, 64)), /boot area/);
  assert.throws(() => readN64Rom(new Uint8Array(0x1000)), /signature/);
});
