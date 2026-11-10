import { NebulusPlayer } from '../player.js';
import type { BrowserTitle } from '../../../../web/shell-types.js';
import {
  c64ControlsFromBrowser,
  replayC64Controls,
  type RecordedControls,
} from '../../../../systems/c64/input.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
export const nebulus: BrowserTitle = {
  id: 'nebulus',
  title: 'Tower Toppler',
  eyebrow: 'NEBULUS / TOWER 01',
  edition: 'FIRST TOWER TRIAL',
  display: { width: 320, height: 200, frameSeconds: 19656 / 985248 },
  audioSupported: true,
  audioDescription: 'Approximate SID sound',
  goal: 'MAKE THE CLIMB',
  heading: 'One tower. A long way up.',
  description:
    'The original title runs automatically. Enable sound for the music, then press Space to begin and guide Pogo around the tower.',
  stats: [
    { id: 'tower', label: 'TOWER' },
    { id: 'lives', label: 'LIVES' },
    { id: 'timer', label: 'TIME' },
  ],
  actions: [{ id: 'fire', label: 'Fire / Jump', hint: 'SPACE', code: 'Space', offsets: [1, 2] }],
  help: [
    'Press Space or Fire to start from the title screen.',
    'Left / Right move around the tower.',
    'Up enters a door or raises a lift. Down lowers a lift.',
    'Space fires or jumps. Press it while walking to jump.',
  ],
  example:
    'A recorded sequence exercises movement, fire and directional jumps through the original game. It demonstrates controls; it is not a tower-completion route.',
  learn: [
    { text: 'Title state and controls', href: './learn/nebulus-player.ts' },
    { text: 'Gameplay and shared runtime', href: './learn/NEBULUS-GAMEPLAY.md' },
  ],
  create(checkpoint, step, input, recording) {
    const controlsAt = recording
      ? replayC64Controls(recording as RecordedControls[])
      : (frame: number) => c64ControlsFromBrowser(input(frame));
    const player = new NebulusPlayer(checkpoint as C64Checkpoint, step, controlsAt);
    return {
      get controlFrames() {
        return player.controlFrames;
      },
      get gap() {
        return player.gap;
      },
      display: player.display,
      get result() {
        return undefined;
      },
      advanceFrame: () => player.advanceFrame(),
      desk: player,
      get startPrompt() {
        return player.waitingToStart ? 'Press Space to start' : undefined;
      },
      enableAudio: (rate) => player.enableAudio(rate),
      takeAudio: () => player.takeAudio(),
      stats: () => {
        if (player.waitingToStart) {
          return { tower: '—', lives: '—', timer: '—' };
        }
        const s = player.stats();
        return { tower: s.tower, lives: s.lives, timer: String(s.time).padStart(4, '0') };
      },
      selected: () => false,
    };
  },
};
export { nebulus as title };
