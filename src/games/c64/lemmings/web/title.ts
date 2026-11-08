import { LemmingsPlayer } from '../player.js';
import type { BrowserTitle } from '../../../../web/shell-types.js';
import {
  c64ControlsFromBrowser,
  replayC64Controls,
  type RecordedControls,
} from '../../../../systems/c64/input.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
export const lemmings: BrowserTitle = {
  id: 'lemmings',
  title: 'Just dig!',
  eyebrow: 'LEMMINGS / LEVEL 01',
  edition: 'FIRST LEVEL TRIAL',
  display: { width: 320, height: 200, frameSeconds: 19656 / 985248 },
  audioSupported: true,
  audioDescription: 'Approximate SID sound',
  goal: 'GET THEM HOME',
  heading: 'A little digging goes a long way.',
  description:
    'Guide at least five lemmings to the exit. Select a digger, move the crosshair over a walking lemming, then press fire.',
  stats: [
    { id: 'rescued', label: 'RESCUED' },
    { id: 'need', label: 'NEED' },
    { id: 'remaining', label: 'ACTIVE' },
    { id: 'clock', label: 'TIME' },
  ],
  actions: [
    {
      id: 'digger',
      label: 'Digger',
      hint: '8',
      code: 'Digit8',
      offsets: [1, 2, 3, 4, 5, 6],
      toggle: true,
      counter: { stat: 'stock', id: 'stock' },
    },
    {
      id: 'nuke',
      label: 'Nuke remaining',
      code: 'Delete',
      offsets: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18],
      quiet: true,
    },
  ],
  gamepadShortcut: 'digger',
  help: [
    'The study runs automatically. Use the keys or on-screen controls.',
    'Arrow keys move the crosshair.',
    '8 selects digger. Space fires.',
    'Delete / Backspace twice ends the remaining lemmings.',
  ],
  example:
    'One digger opens a passage. Six lemmings reach the exit; the example then ends the two trapped lemmings using the original nuke control. It plays at 4× speed.',
  learn: [
    { text: 'Named digger routines', href: './learn/digger.ts' },
    { text: 'Digger walkthrough', href: './learn/LEMMINGS-DIGGER.md' },
  ],
  create(checkpoint, step, input, recording) {
    const controlsAt = recording
      ? replayC64Controls(recording as RecordedControls[])
      : (frame: number) => c64ControlsFromBrowser(input(frame));
    const player = new LemmingsPlayer(checkpoint as C64Checkpoint, step, (frame) => {
      const controls = controlsAt(frame);
      return {
        joystick: controls.joystick,
        key8: controls.keys.includes(27),
        deleteKey: controls.keys.includes(0),
      };
    });
    return {
      get controlFrames() {
        return player.controlFrames;
      },
      get gap() {
        return player.gap;
      },
      display: player.display,
      get result() {
        const result = player.outcome;
        return result
          ? {
              won: result.won,
              title: result.won ? 'You did it!' : 'Try another route',
              detail: `${result.rescued} of ${result.total} rescued · ${result.percent}% saved · ${result.required}% needed`,
            }
          : undefined;
      },
      advanceFrame: () => player.advanceFrame(),
      enableAudio: (rate) => player.enableAudio(rate),
      takeAudio: () => player.takeAudio(),
      stats: () => {
        const s = player.stats();
        return {
          rescued: `${s.rescued}/${s.total}`,
          need: `${player.header.rescuePercentShown}%`,
          remaining: s.alive,
          clock: `${Math.floor(s.seconds / 60)}:${String(s.seconds % 60).padStart(2, '0')}`,
          stock: s.stock,
        };
      },
      selected: (action) => action === 'digger' && player.bus.bytes[0x5c0] === 7,
    };
  },
};
export { lemmings as title };
