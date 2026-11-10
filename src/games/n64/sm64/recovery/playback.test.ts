import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSm64Playback } from './playback.js';

test('SM64 fixture modes are explicit and mutually exclusive before reading media', async () => {
  await assert.rejects(
    prepareSm64Playback({
      titleFixtureFingerprint: 'a'.repeat(64),
      replayFixtureFingerprint: 'b'.repeat(64),
    }),
    /not both/,
  );
});
