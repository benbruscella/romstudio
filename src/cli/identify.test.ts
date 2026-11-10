import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyBytes } from './identify.js';
import { sha256 } from '../core.js';

test('raw bytes remain unidentified until an exact chip identity supplies evidence', () => {
  const bytes = new Uint8Array(8192),
    unknown = identifyBytes('something.chr', bytes);
  assert.equal(unknown.format, 'binary');
  assert.deepEqual(unknown.systems, []);
  const known = identifyBytes('renamed.bin', bytes, [
    { game: 'fixture', title: 'Fixture', role: 'chr', system: 'nes', sha256: sha256(bytes) },
  ]);
  assert.equal(known.format, 'raw-nes-chip');
  assert.deepEqual(known.systems, ['nes']);
});
test('identification reads unsupported cartridge metadata without claiming it can run it', () => {
  const bytes = new Uint8Array(16 + 16384 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0x21]);
  const result = identifyBytes('game.nes', bytes);
  assert.equal(result.format, 'ines');
  assert.equal(result.details.mapper, 2);
  assert.equal(result.details.mirroring, 'vertical');
  assert.throws(() => identifyBytes('bad.nes', bytes.slice(0, 30)), /lengths/);
});
test('PRG identification bounds its payload and reports a load address without guessing a game', () => {
  const result = identifyBytes('game.prg', Uint8Array.of(0, 0x80, 0x60));
  assert.equal(result.details.loadAddress, 0x8000);
  assert.deepEqual(result.matches, []);
  assert.throws(() => identifyBytes('bad.prg', Uint8Array.of(0xff, 0xff, 0, 0)), /address space/);
});

test('an N64 raw chip filename is identified from its byte-swapped cartridge header', () => {
  const canonical = new Uint8Array(0x1000);
  canonical.set([0x80, 0x37, 0x12, 0x40]);
  canonical.set(new TextEncoder().encode('SUPER MARIO 64      '), 0x20);
  canonical.set(new TextEncoder().encode('NSMP'), 0x3b);
  const bytes = Uint8Array.from(canonical, (_, index) => canonical[index ^ 1]!);
  const result = identifyBytes('nus-nsmp-0.u1', bytes);
  assert.equal(result.format, 'n64-cartridge');
  assert.equal(result.details.byteOrder, 'byte-swapped-16');
  assert.equal(result.details.title, 'SUPER MARIO 64');
  assert.equal(result.details.canonicalSha256, sha256(canonical));
  assert.deepEqual(result.systems, ['n64']);
});
