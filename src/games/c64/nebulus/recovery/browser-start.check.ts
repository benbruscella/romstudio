import assert from 'node:assert/strict';
import type { BrowserTitle } from '../../../../web/shell-types.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
import type { Machine } from '../../../../runtime/mos6502.js';

/** Shared by the fresh-build integration test and focused export checks.
 * The original game spends several PAL seconds drawing the tower after Fire
 * is released. Observe the countdown starting, with a bounded deadline. */
export function checkBrowserStart(
  title: BrowserTitle,
  checkpoint: C64Checkpoint,
  step: (machine: Machine) => void,
) {
  let fire = false;
  const player = title.create(checkpoint, step, () => ({ pressed: fire ? ['Space'] : [] }));
  player.enableAudio(44100);
  for (let frame = 0; frame < 60; frame++) {
    player.advanceFrame();
  }
  assert.equal(player.gap, undefined);
  assert.equal(player.startPrompt, 'Press Space to start');
  assert.equal(player.stats().timer, '—');
  assert.ok(player.takeAudio().some((sample) => Math.abs(sample) > 0.001));
  fire = true;
  for (let frame = 0; frame < 10; frame++) {
    player.advanceFrame();
  }
  fire = false;
  let frames = 0;
  const countdownStarted = () => {
    const timer = Number(player.stats().timer);
    return player.startPrompt === undefined && timer > 0 && timer < 1000;
  };
  while (frames < 600 && !player.gap && !countdownStarted()) {
    player.advanceFrame();
    frames++;
  }
  assert.equal(player.gap, undefined, JSON.stringify(player.gap));
  assert.equal(player.startPrompt, undefined);
  assert.equal(player.stats().tower, 1);
  assert.ok(countdownStarted(), `Countdown did not start within ${frames} PAL frames.`);
  return { framesAfterRelease: frames, timer: player.stats().timer };
}
