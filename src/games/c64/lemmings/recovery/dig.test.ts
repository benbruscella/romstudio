import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digTrial } from './dig.js';
test('malformed replay input is rejected before starting the media runner', async () => {
  await assert.rejects(
    digTrial({ inputReplay: [{ frame: 0, joystick: 255, key8: false }] }),
    /ordered/,
  );
  await assert.rejects(
    digTrial({
      inputReplay: [
        { frame: 2, joystick: 255, key8: false },
        { frame: 1, joystick: 255, key8: false },
      ],
    }),
    /ordered/,
  );
});
