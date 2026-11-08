import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameIdentity, gameKey, resolveGameKey } from './game-id.js';
import { gameBuildDirectory, gameSourceDirectory } from './paths.js';

const ports = [
  { system: 'c64', id: 'tetris' },
  { system: 'nes', id: 'tetris' },
  { system: 'nes', id: 'smb' },
];

test('platform versions have distinct selectors, source and output directories', () => {
  assert.equal(resolveGameKey('c64/tetris', ports), 'c64/tetris');
  assert.equal(resolveGameKey('nes/tetris', ports), 'nes/tetris');
  assert.notEqual(gameBuildDirectory('c64/tetris'), gameBuildDirectory('nes/tetris'));
  assert.notEqual(gameSourceDirectory('c64/tetris'), gameSourceDirectory('nes/tetris'));
  assert.deepEqual(gameIdentity(gameKey('nes', 'tetris')), ports[1]);
});

test('short names resolve only when unique or qualified by a system', () => {
  assert.equal(resolveGameKey('smb', ports), 'nes/smb');
  assert.equal(resolveGameKey('tetris', ports, 'c64'), 'c64/tetris');
  assert.throws(
    () => resolveGameKey('tetris', ports),
    /multiple systems.*c64\/tetris.*nes\/tetris/,
  );
  assert.throws(() => resolveGameKey('nes/tetris', ports, 'c64'), /Unknown game/);
  assert.throws(() => resolveGameKey('unknown', ports), /Unknown game/);
});

test('platform identities cannot escape their source or output directories', () => {
  for (const value of [
    '../tetris',
    'nes/../tetris',
    '/nes/tetris',
    'nes/tetris/',
    'nes\\tetris',
    'nes/..',
  ]) {
    assert.throws(() => gameIdentity(value), /system\/game|slugs/);
  }
});
