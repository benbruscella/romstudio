import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeMediaBundle } from './media-bundle.js';
import { sha256 } from '../core.js';
test('CI media bundles accept only exact pinned identities and bytes', () => {
  const bytes = Uint8Array.of(1, 2, 3),
    expected = [{ id: 'fixture/program', sha256: sha256(bytes) }];
  const pack = (files: unknown[]) => gzipSync(JSON.stringify({ version: 1, files }));
  const file = { id: 'fixture/program', data: Buffer.from(bytes).toString('base64') };
  assert.deepEqual([...decodeMediaBundle(pack([file]), expected).get(file.id)!], [1, 2, 3]);
  assert.throws(
    () => decodeMediaBundle(pack([{ ...file, id: '../../outside' }]), expected),
    /Unexpected/,
  );
  assert.throws(
    () => decodeMediaBundle(pack([{ ...file, data: 'AAAA' }]), expected),
    /hash mismatch/,
  );
  assert.throws(() => decodeMediaBundle(pack([]), expected), /exactly/);
  assert.throws(() => decodeMediaBundle(pack([file, file]), expected), /exactly/);
});
