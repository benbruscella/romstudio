import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeMediaBundle, isSealed, mediaKey, sealBundle, unsealBundle } from './media-bundle.js';
import { randomBytes } from 'node:crypto';
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

test('sealed CI media opens only with its key and rejects tampering', () => {
  const key = randomBytes(32),
    bundle = gzipSync(JSON.stringify({ version: 1, files: [] }));
  const sealed = sealBundle(bundle, key);
  assert.ok(isSealed(sealed));
  assert.ok(!isSealed(bundle));
  assert.ok(!sealed.includes(bundle), 'ciphertext must not contain the plain bundle');
  assert.deepEqual(unsealBundle(sealed, key), bundle);
  assert.throws(() => unsealBundle(sealed, randomBytes(32)), { code: 'MEDIA_KEY' });
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  assert.throws(() => unsealBundle(tampered, key), { code: 'MEDIA_KEY' });
  assert.deepEqual(mediaKey(key.toString('base64')), key);
  assert.throws(() => mediaKey('short'), { code: 'MEDIA_KEY' });
  assert.throws(() => mediaKey(undefined), { code: 'MEDIA_KEY' });
});
