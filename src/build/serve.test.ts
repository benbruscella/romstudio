import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveWeb } from './serve.js';
import { sha256 } from '../core.js';

test('the preview serves only declared, unchanged files and rejects modified exports', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-http-'));
  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;
  try {
    const html = '<!doctype html><title>Local fixture</title>';
    await writeFile(join(directory, 'index.html'), html);
    await writeFile(join(directory, 'secret.txt'), 'not served');
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        verification: { referenceReplay: 'passed' },
        files: { 'index.html': sha256(html) },
      }),
    );
    try {
      server = await serveWeb(directory, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Loopback listening is restricted in this test environment.');
        return;
      }
      throw error;
    }
    assert.equal(await (await fetch(server.url)).text(), html);
    assert.equal((await fetch(server.url + '/secret.txt')).status, 404);
    assert.equal((await fetch(server.url + '/%2e%2e%2fsecret.txt')).status, 404);
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    await writeFile(join(directory, 'index.html'), 'changed');
    await assert.rejects(serveWeb(directory, 0), /Changed export file/);
  } finally {
    await new Promise<void>((resolveClose) =>
      server ? server.server.close(() => resolveClose()) : resolveClose(),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('refreshing the preview adopts a newly verified export and rejects an invalid replacement', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-refresh-'));
  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;
  const publish = async (html: string, hash = sha256(html)) => {
    await writeFile(join(directory, 'index.html'), html);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        verification: { referenceReplay: 'passed' },
        files: { 'index.html': hash },
      }),
    );
  };
  try {
    await publish('<title>First build</title>');
    try {
      server = await serveWeb(directory, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Loopback listening is restricted in this test environment.');
        return;
      }
      throw error;
    }
    assert.equal(await (await fetch(server.url)).text(), '<title>First build</title>');
    await publish('<title>Corrected build</title>');
    assert.equal(await (await fetch(server.url)).text(), '<title>Corrected build</title>');
    await publish('<title>Unverified change</title>', sha256('different bytes'));
    assert.equal((await fetch(server.url)).status, 503);
    await publish('<title>Verified again</title>');
    assert.equal(await (await fetch(server.url)).text(), '<title>Verified again</title>');
  } finally {
    await new Promise<void>((resolveClose) =>
      server ? server.server.close(() => resolveClose()) : resolveClose(),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
