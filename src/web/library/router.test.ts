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
