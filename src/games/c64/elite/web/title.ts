import type { BrowserTitle } from '../../../../web/shell-types.js';
import { ElitePlayer } from '../player.js';
import {
  c64ControlsFromBrowser,
  replayC64Controls,
  type RecordedControls,
} from '../../../../systems/c64/input.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';

const keyPulse = Array.from({ length: 24 }, (_, index) => index + 1);
export const title: BrowserTitle = {
  id: 'elite',
  title: 'Elite',
  eyebrow: 'C64 / ELITE',
  edition: 'COMMANDER JAMESON STUDY',
  display: { width: 320, height: 200, frameSeconds: 19656 / 985248 },
  minimumInputPolls: 24,
  audioSupported: true,
  audioDescription: 'Approximate SID sound',
  stats: [],
  goal: 'LEAVE LAVE',
  heading: 'From a binary to a galaxy.',
  description:
    'Press N for a new commander, then Space at the title prompt. F1 launches from the station. Arrows control the joystick; Space fires.',
  actions: [
    { id: 'new-commander', label: 'New commander', hint: 'N', code: 'KeyN', offsets: keyPulse },
    { id: 'start-fire', label: 'Start / Fire', hint: 'SPACE', code: 'Space', offsets: keyPulse },
    { id: 'launch', label: 'Launch / Front', hint: 'F1', code: 'F1', offsets: keyPulse },
    { id: 'rear', label: 'Rear', hint: 'F3', code: 'F3', offsets: keyPulse },
    { id: 'left-view', label: 'Left view', hint: 'F5', code: 'F5', offsets: keyPulse },
    { id: 'right-view', label: 'Right view', hint: 'F7', code: 'F7', offsets: keyPulse },
  ],
  help: [
    'N: use a new Commander Jameson. Space: continue from the title.',
    'F1: launch while docked / front view in flight.',
    'F3 / F5 / F7: rear / left / right views.',
    'Arrows: joystick. Space: fire. Saved commanders and full progression are outside this slice.',
  ],
  example:
    'The original new-commander, title, launch and bounded flight controls. It is not a completed trading or combat run.',
  learn: [{ text: 'Elite study', href: './learn/README.md' }],
  create(checkpoint, step, input, recording) {
    const replay = recording ? replayC64Controls(recording as RecordedControls[]) : undefined;
    const player = new ElitePlayer(checkpoint as C64Checkpoint, step, (frame) => {
      if (replay) {
        return replay(frame);
      }
      const controls = input(frame),
        pins = c64ControlsFromBrowser(controls),
        keys = new Set<number>(pins.keys);
      for (const [code, key] of [
        ['KeyN', 39],
        ['Space', 60],
        ['F1', 4],
        ['F3', 5],
        ['F5', 6],
        ['F7', 3],
      ] as const) {
        if (controls.pressed.includes(code)) {
          keys.add(key);
        }
      }
      return { joystick: pins.joystick, keys: [...keys].sort((a, b) => a - b) };
    });
    return {
      get controlFrames() {
        return player.controlFrames;
      },
      get gap() {
        return player.gap;
      },
      get result() {
        return undefined;
      },
      display: player.display,
      advanceFrame: () => player.advanceFrame(),
      desk: player,
      enableAudio: (rate) => player.enableAudio(rate),
      takeAudio: () => player.takeAudio(),
      stats: () => ({}),
      selected: () => false,
    };
  },
};
