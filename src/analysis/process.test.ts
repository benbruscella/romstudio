import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseInProcess } from './process.js';
test('isolated analysis preserves binary evidence and reports child errors and exits', async () => {
  const worker = new URL('./process.fixture.js', import.meta.url),
    bytes = Uint8Array.from([0, 127, 255]);
  const result = await analyseInProcess<
    { action: string; bytes: Uint8Array },
    { bytes: Uint8Array }
  >(worker, { action: 'echo', bytes });
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(
    analyseInProcess(worker, { action: 'error', bytes }),
    /Fixture analysis failed/,
  );
  await assert.rejects(
    analyseInProcess(worker, { action: 'crash', bytes }),
    /Analysis process stopped: 7/,
  );
});
