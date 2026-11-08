import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBounded } from './files.js';
import { Diagnostic } from './core.js';
test('input reads enforce allocation limits and reject non-files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-input-'));
  try {
    const path = join(directory, 'test');
    await writeFile(path, '12345');
    assert.equal((await readBounded(path, 5)).toString(), '12345');
    await assert.rejects(
      readBounded(path, 4),
      (e: unknown) => e instanceof Diagnostic && e.code === 'INPUT_SIZE',
    );
    await assert.rejects(
      readBounded(directory, 4),
      (e: unknown) => e instanceof Diagnostic && e.code === 'INPUT_TYPE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
