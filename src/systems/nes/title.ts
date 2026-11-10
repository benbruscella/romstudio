import type { BrowserTitle } from '../../web/shell-types.js';
import { NesPlayer, replayNesControls, type RecordedNesControls } from './player.js';
import { NES_PAL_CPU_HZ, NES_PAL_FRAME_CYCLES, type NesLaunch } from './system.js';

/** Shared NES browser wiring; game-specific prose and examples stay in games/. */
export function nesBrowserTitle(
  game: Pick<
    BrowserTitle,
    'id' | 'title' | 'eyebrow' | 'heading' | 'description' | 'example' | 'help'
  >,
): BrowserTitle {
  return {
    ...game,
    edition: 'PAL NES STUDY',
    goal: 'PLAY THE ORIGINAL',
    display: { width: 256, height: 240, frameSeconds: NES_PAL_FRAME_CYCLES / NES_PAL_CPU_HZ },
    minimumInputPolls: 4,
    audioSupported: true,
    audioDescription: 'Original PAL NES audio; analogue output is approximate.',
    stats: [],
    actions: [
      { id: 'start', label: 'Start', hint: 'ENTER', code: 'Enter', offsets: [1, 2, 3, 4] },
      { id: 'a', label: 'A', hint: 'Z / SPACE', code: 'KeyZ', offsets: [1, 2, 3, 4] },
      { id: 'b', label: 'B', hint: 'X', code: 'KeyX', offsets: [1, 2, 3, 4] },
    ],
    gamepadShortcut: 'b',
    learn: [{ text: 'About this game study', href: './learn/README.md' }],
    create(checkpoint, step, input, recording) {
      const replay = recording ? replayNesControls(recording as RecordedNesControls[]) : undefined;
      const player = new NesPlayer(checkpoint as NesLaunch, step, (frame) => {
        if (replay) {
          return replay(frame);
        }
        const keys = new Set(input(frame).pressed);
        let buttons = 0;
        for (const [key, bit] of [
          ['Space', 1],
          ['KeyZ', 1],
          ['KeyX', 2],
          ['ShiftRight', 4],
          ['Enter', 8],
          ['ArrowUp', 16],
          ['ArrowDown', 32],
          ['ArrowLeft', 64],
          ['ArrowRight', 128],
        ] as const) {
          if (keys.has(key)) {
            buttons |= bit;
          }
        }
        return { buttons };
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
}
