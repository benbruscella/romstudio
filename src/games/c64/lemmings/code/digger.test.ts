import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignDigger } from './digger.js';
test('digger assignment keeps direction/state bits, rejects excluded modes and requires stock', () => {
  const actor = { x: 126, y: 73, mode: 0x88, animation: 0x32, extra: 0x84 };
  assert.deepEqual(assignDigger(actor, 10), {
    assigned: true,
    actor: { ...actor, mode: 0x86, animation: 2, extra: 128 },
    stock: 9,
  });
  for (const mode of [0, 1, 2, 6, 16, 17, 0x82, 0x86]) {
    assert.equal(assignDigger({ ...actor, mode }, 10).assigned, false);
  }
  assert.equal(assignDigger(actor, 0).assigned, false);
  assert.deepEqual(actor, { x: 126, y: 73, mode: 0x88, animation: 0x32, extra: 0x84 });
});
