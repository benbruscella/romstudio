import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameDelivery, requireReadyGames } from './delivery.js';

test('an unfinished game stays out of public execution while Learn keeps its evidence', () => {
  const publicStudy = gameDelivery('partial-title');
  assert.equal(publicStudy.experimental, true);
  assert.equal(publicStudy.runtime, false);
  for (const file of [
    'index.html',
    'checkpoint.json',
    'example.json',
    'game-code/program.js',
    'game-code/rsp/program.js',
    'systems/c64/player.js',
  ]) {
    assert.equal(publicStudy.includes(file), false, file);
  }
  for (const file of [
    'game-code/program.ts',
    'game-code/observed-source.json',
    'game-code/rsp/program.ts',
    'game-code/rsp/observed-source.json',
    'game-code/observations/0000.json',
    'game-code/rsp-play/observations/0001.json',
    'learn/README.md',
    'reference-final.png',
  ]) {
    assert.equal(publicStudy.includes(file), true, file);
  }
  assert.equal(gameDelivery('unknown').runtime, false);
});

test('a release cannot silently replace unfinished games with Learn-only entries', () => {
  assert.throws(
    () => requireReadyGames([{ id: 'elite', runnable: true, experimental: true }]),
    /Unfinished: elite/,
  );
  assert.throws(
    () => requireReadyGames([{ id: 'tetris', runnable: false, experimental: false }]),
    /Unfinished: tetris/,
  );
  requireReadyGames([{ id: 'lemmings', runnable: true, experimental: false }]);
});

test('interactive studies need an explicit opt-in; ready games retain execution files', () => {
  const development = gameDelivery('partial-title', true);
  assert.equal(development.experimental, true);
  assert.equal(development.includes('game-code/program.js'), true);
  const ready = gameDelivery('release-ready');
  assert.equal(ready.experimental, false);
  assert.equal(ready.includes('checkpoint.json'), true);
});
