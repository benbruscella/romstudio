import { nesBrowserTitle } from '../../../../systems/nes/title.js';
export const title = nesBrowserTitle({
  id: 'tetris',
  title: 'Tetris',
  eyebrow: 'NES / TETRIS',
  heading: 'The original falling blocks, opened up.',
  description:
    'Play runs the original cartridge startup. Press Enter through the title and setup screens. Use arrows to select and move blocks; Z/Space and X rotate.',
  help: [
    'Enter: Start / confirm / pause. Right Shift: Select.',
    'Left / Right: move. Down: soft drop.',
    'Z or Space: A rotation. X: B rotation.',
  ],
  example:
    'A recorded sequence advances through the original menus and demonstrates piece movement and rotation. It does not establish full-game coverage.',
});
