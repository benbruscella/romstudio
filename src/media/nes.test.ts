import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInes, rawNesChips, inesReader } from './nes.js';
test('iNES validates chip geometry and raw dumps require explicit board wiring', () => {
  const bytes = new Uint8Array(16 + 32768 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 1]);
  const media = readInes(bytes);
  assert.equal(media.cartridge.mapper, 0);
  assert.equal(media.cartridge.mirroring, 'vertical');
  assert.equal(media.identity[0]!.bytes, 32768);
  assert.equal(inesReader.probe(bytes)?.confidence, 1);
  assert.throws(() => readInes(bytes.slice(0, -1)), /lengths/);
  assert.throws(
    () =>
      rawNesChips(new Uint8Array(32768), new Uint8Array(16384), {
        mapper: 0,
        mirroring: 'vertical',
      }),
    /sizes/,
  );
});
