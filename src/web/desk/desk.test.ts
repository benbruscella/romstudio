import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservationIndex, symbolAt, sourcePageFor } from './observations.js';
import { parseDeskAddress } from './panel.js';
import { identifyMedia } from '../library/identify.js';
import type { DeskSymbol } from './types.js';

const symbols: DeskSymbol[] = [
  { start: 0x1dd9, end: 0x1e69, name: 'Lemming release routine', detail: '', evidence: 'a' },
  { start: 0x1e21, end: 0x1e5b, name: 'Inner loop', detail: '', evidence: 'b' },
  { start: 0x8000, end: 0x8000, name: 'Reset handler', detail: '', evidence: 'c' },
];

test('Desk names the narrowest documented routine and parses addresses', () => {
  assert.equal(symbolAt(symbols, 0x1e30)?.name, 'Inner loop');
  assert.equal(symbolAt(symbols, 0x1de0)?.name, 'Lemming release routine');
  assert.equal(symbolAt(symbols, 0x1000), undefined);
  assert.equal(parseDeskAddress('$8000', symbols, 65536), 0x8000);
  assert.equal(parseDeskAddress('reset handler', symbols, 65536), 0x8000);
  assert.equal(parseDeskAddress('0x80246000', [], 2 ** 32), 0x80246000);
  assert.equal(parseDeskAddress('10000', [], 65536), undefined);
  assert.equal(parseDeskAddress('nope', symbols, 65536), undefined);
  assert.equal(sourcePageFor(0x80246abc, true), 'pages/80246000.ts');
  assert.equal(sourcePageFor(0xc123, false), 'pages/c000.ts');
});

test('paged observations are found by binary search, including across a page edge', async () => {
  const pages: Record<string, unknown> = {
    'd/observed-source.json': {
      mappings: [],
      parts: ['observations/0000.json', 'observations/0001.json', 'observations/0002.json'],
    },
    'd/observations/0000.json': [
      { address: 0x100, opcode: 1, bytes: [1], assembly: 'A' },
      { address: 0x200, opcode: 2, bytes: [2], assembly: 'B' },
    ],
    'd/observations/0001.json': [
      { address: 0x200, opcode: 3, bytes: [3], assembly: 'C' },
      { address: 0x300, opcode: 4, bytes: [4], assembly: 'D' },
    ],
    'd/observations/0002.json': [{ address: 0x400, opcode: 5, bytes: [5], assembly: 'E' }],
  };
  const requested: string[] = [];
  const request = (async (url: string) => {
    requested.push(url);
    return url in pages
      ? new Response(JSON.stringify(pages[url]))
      : new Response('missing', { status: 404 });
  }) as typeof fetch;
  const index = await ObservationIndex.load('d/', request);
  assert.deepEqual((await index.at(0x200)).map((item) => item.assembly).sort(), ['B', 'C']);
  assert.deepEqual(
    (await index.at(0x400)).map((item) => item.assembly),
    ['E'],
  );
  assert.deepEqual(await index.at(0x250), []);
  assert.ok(requested.length <= 4, 'only the pages a search needs are fetched');
});

test('media identification: exact hash, other release by header or name, unknown', () => {
  const known = [
    {
      game: 'sm64',
      system: 'n64',
      name: 'sm64.z64',
      title: 'Super Mario 64 — Europe',
      sha256: 'aa',
    },
    {
      game: 'lemmings',
      system: 'c64',
      name: 'lemmings.d64',
      title: 'Lemmings — Just dig!',
      sha256: 'bb',
    },
  ];
  const rom = new Uint8Array(0x1000);
  rom.set([0x80, 0x37, 0x12, 0x40]);
  rom.set(new TextEncoder().encode('SUPER MARIO 64      '), 0x20);
  assert.equal(identifyMedia('x.z64', rom, 'aa', known).kind, 'exact');
  const other = identifyMedia('x.z64', rom, 'cc', known);
  assert.equal(other.kind, 'other-release');
  assert.equal(other.hint, 'SUPER MARIO 64');
  assert.equal(other.game?.id, 'sm64');
  // Byte-swapped (.v64) order reads the same header name.
  const swapped = rom.slice();
  for (let i = 0; i < swapped.length; i += 2) {
    [swapped[i], swapped[i + 1]] = [rom[i + 1]!, rom[i]!];
  }
  assert.equal(identifyMedia('y.v64', swapped, 'dd', known).hint, 'SUPER MARIO 64');
  assert.equal(
    identifyMedia('Lemmings (side A).d64', new Uint8Array(10), 'ee', known).kind,
    'other-release',
  );
  assert.equal(identifyMedia('mystery.bin', new Uint8Array(10), 'ff', known).kind, 'unknown');
});
