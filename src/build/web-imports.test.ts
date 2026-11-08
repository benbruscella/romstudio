import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebImports } from './web-imports.js';

test('a copied browser shell cannot silently omit a new import', () => {
  const modules = new Map([['web/app.js', "import { browserKey } from './keyboard.js';"]]);
  assert.throws(() => verifyWebImports(modules), /keyboard.js imported by web\/app.js/);
  modules.set('web/keyboard.js', 'export function browserKey() {}');
  verifyWebImports(modules);
});

test('browser packaging validates re-exports and literal dynamic imports and rejects Node modules', () => {
  const modules = new Map([
    [
      'web/app.js',
      "export { title } from '../games/title.js';\nconst p = import('../game-code/program.js');",
    ],
    ['games/title.js', 'export const title = {};'],
    ['game-code/program.js', 'export function step() {}'],
  ]);
  verifyWebImports(modules);
  modules.set('web/app.js', "import fs from 'node:fs';");
  assert.throws(() => verifyWebImports(modules), /node:fs/);
  modules.set('web/app.js', "const compile = new Function('return 1');");
  assert.throws(() => verifyWebImports(modules), /Runtime code generation/);
});
