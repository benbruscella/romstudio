import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderN64ColorImage } from './render.js';
test('N64 buffer captures decode big-endian colors and keep coverage separate from canvas alpha', () => {
  const ram = Uint8Array.from([0xf8, 0x00, 0x07, 0xc1, 0, 0x3f, 0xff, 0xff]);
  assert.deepEqual(
    [...renderN64ColorImage(ram, { format: 0, size: 2, width: 2, address: 0 }, 2)],
    [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
  );
  assert.deepEqual(
    [...renderN64ColorImage(ram, { format: 0, size: 3, width: 2, address: 0 }, 1)],
    [248, 0, 7, 255, 0, 63, 255, 255],
  );
  assert.throws(
    () => renderN64ColorImage(ram, { format: 0, size: 2, width: 2, address: 0 }, 3),
    /exceeds/,
  );
});
