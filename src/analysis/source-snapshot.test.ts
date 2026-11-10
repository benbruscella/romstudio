import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sourceSnapshot, assertSourceSnapshot } from './source-snapshot.js';

test('model snapshots follow imports, exports, types, workers and actual compiled dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'romstudio-source-'));
  const put = async (name: string, source: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), source);
  };
  try {
    await put(
      'src/root.ts',
      `import './math.js'; export * from './constants.js';
      import type { State } from './types.js'; import('./dynamic.js');
      new URL('./worker.js', import.meta /* comments preserve the AST */ .url);
      // import './not-real.js';
      const emitted = "import './also-not-real.js'";`,
    );
    await put('dist/tools/src/root.js', `require('./compiled-only.js');`);
    for (const name of ['math', 'constants', 'types', 'dynamic', 'worker', 'compiled-only']) {
      await put(`src/${name}.ts`, `export const value = 1;`);
      await put(`dist/tools/src/${name}.js`, `export const value = 1;`);
    }
    const snapshot = await sourceSnapshot(['src/root.ts'], { root, configuration: [] });
    assert.equal(Object.keys(snapshot.files).length, 14);
    assert.ok(snapshot.files['src/compiled-only.ts']);
    await assertSourceSnapshot(snapshot, root);
    await put('src/math.ts', 'export const value = 2;');
    await assert.rejects(assertSourceSnapshot(snapshot, root), /changed/);
    const sourceChanged = await sourceSnapshot(['src/root.ts'], { root, configuration: [] });
    await put('dist/tools/src/math.js', 'export const value = 3;');
    await assert.rejects(assertSourceSnapshot(sourceChanged, root), /changed/);
    await put('src/math.ts', `export * from './root.js';`); // A cycle is finite.
    const cyclic = await sourceSnapshot(['src/root.ts'], { root, configuration: [] });
    assert.equal(Object.keys(cyclic.files).length, 14);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real SM64 model closure includes numeric helpers and their emitted code', async () => {
  const snapshot = await sourceSnapshot(['src/games/n64/sm64/recovery/playback.ts']);
  for (const name of ['runtime/binary-float', 'transpiler/rsp-recovery', 'runtime/vr4300-memory']) {
    assert.ok(snapshot.files[`src/${name}.ts`], name);
    assert.ok(snapshot.files[`dist/tools/src/${name}.js`], name);
  }
  assert.ok(snapshot.files['package.json']);
});

test('model snapshots fail on missing emitted helpers and dependency escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'romstudio-source-errors-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/root.ts'), 'export {};');
    await assert.rejects(sourceSnapshot(['src/root.ts'], { root, configuration: [] }), /ENOENT/);
    await assert.rejects(
      sourceSnapshot(['../outside.ts'], { root, configuration: [] }),
      /inside the project/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
