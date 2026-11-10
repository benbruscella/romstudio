import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LemmingsDisks } from '../recovery/level.js';
import { levelText } from './level-data.js';
test('level text preserves the mixed uppercase/lowercase screen alphabet', () => {
  assert.equal(levelText([32, 0x4a, 21, 19, 20, 32, 4, 9, 7, 33, 32]), 'Just dig!');
  assert.throws(() => levelText([255]), /Unsupported/);
});

test('automatic disk selection stops on ambiguity and retains a present file', () => {
  const file = { bytes: new Uint8Array(), mediaHash: 'fixture', fileId: 'fixture' };
  const disks = new LemmingsDisks([
    new Map([['SA', file]]),
    new Map([
      ['FA', file],
      ['CA', file],
    ]),
    new Map([['CA', file]]),
  ]);
  assert.equal(disks.get('SA'), file);
  assert.equal(disks.get('CA'), undefined);
  assert.equal(disks.active, 0);
  assert.equal(disks.get('FA'), file);
  assert.deepEqual(disks.mounts, [{ name: 'FA', disk: 1 }]);
  assert.equal(disks.get('CA'), file);
});
