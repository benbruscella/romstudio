import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryRoute } from './router.js';

test('history routes work at root and GitHub Pages project bases', () => {
  assert.deepEqual(libraryRoute('/c64/nebulus', '/'), {
    system: 'c64',
    game: 'nebulus',
    view: 'play',
  });
  assert.deepEqual(libraryRoute('/romstudio/nes/smb/learn/overview', '/romstudio/'), {
    system: 'nes',
    game: 'smb',
    view: 'learn',
    chapter: 'overview',
  });
  assert.deepEqual(libraryRoute('/romstudio/', '/romstudio/'), { view: 'play' });
  assert.equal(libraryRoute('/c64/nebulus', '/romstudio/'), undefined);
  assert.equal(libraryRoute('/romstudio/c64/x/bad/path', '/romstudio/'), undefined);
  assert.equal(libraryRoute('/romstudio/%zz', '/romstudio/'), undefined);
});

test('ROM Desk routes: per-game Desk and top-level media identification', () => {
  assert.deepEqual(libraryRoute('/n64/sm64/desk', '/'), {
    system: 'n64',
    game: 'sm64',
    view: 'desk',
  });
  assert.deepEqual(libraryRoute('/romstudio/desk', '/romstudio/'), { view: 'identify' });
  assert.equal(libraryRoute('/n64/sm64/desk/extra', '/'), undefined);
  assert.equal(libraryRoute('/desk/c64', '/'), undefined);
});
