import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionTypeScript, loadCodeObservations } from './code.js';
test('the learning explorer selects a generated source-address function without executing it', () => {
  const source =
    'import type {Machine} from "x";\nfunction at_1568_a9(s: Machine) { s.a = 1; }\nfunction at_156a_60(s: Machine) { s.rts(); }\nconst program = new Map();';
  assert.equal(
    instructionTypeScript(source, 0x1568, 0xa9),
    'function at_1568_a9(s: Machine) { s.a = 1; }',
  );
  assert.equal(
    instructionTypeScript(source, 0x156a, 0x60),
    'function at_156a_60(s: Machine) { s.rts(); }',
  );
  assert.match(instructionTypeScript(source, 0x9999, 0xea), /No generated/);
});

test('code observations preserve inline and paged instruction provenance', async () => {
  const first = {
    address: 0x80241800,
    bytes: [0x3c, 8, 0x80, 0x34],
    provenance: { evidence: 'observed' },
  };
  const second = { address: 0x80241804, bytes: [0, 0, 0, 0], sourceFile: 'pages/80241000.ts' };
  const requests: string[] = [];
  const values = new Map<string, unknown>([
    [
      '/code/observed-source.json',
      { mappings: [first], scope: 'Recorded route', parts: ['observations/0000.json'] },
    ],
    ['/code/observations/0000.json', [second]],
  ]);
  const request: typeof fetch = async (input) => {
    const path = String(input);
    requests.push(path);
    return new Response(JSON.stringify(values.get(path)), { status: values.has(path) ? 200 : 404 });
  };
  assert.deepEqual(await loadCodeObservations('/code/', request), {
    mappings: [first, second],
    scope: 'Recorded route',
  });
  assert.deepEqual(requests, ['/code/observed-source.json', '/code/observations/0000.json']);
  values.set('/code/observed-source.json', { mappings: [first], scope: 'Recorded route' });
  assert.deepEqual((await loadCodeObservations('/code/', request)).mappings, [first]);
});

test('observation pages cannot escape the game or silently disappear', async () => {
  for (const part of ['../outside.json', 'https://example.com/code.json']) {
    let requests = 0;
    await assert.rejects(
      loadCodeObservations('/code/', async () => {
        requests++;
        return new Response(JSON.stringify({ mappings: [], parts: [part] }));
      }),
      /Invalid code observation index/,
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    loadCodeObservations('/code/', async (input) =>
      String(input).endsWith('observed-source.json')
        ? new Response(JSON.stringify({ mappings: [], parts: ['observations/0000.json'] }))
        : new Response('', { status: 404 }),
    ),
    /page is unavailable/,
  );
});
