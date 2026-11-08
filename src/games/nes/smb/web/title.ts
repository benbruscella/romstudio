import { nesBrowserTitle } from '../../../../systems/nes/title.js';
export const title = nesBrowserTitle({
  id: 'smb',
  title: 'Super Mario Bros.',
  eyebrow: 'NES / SUPER MARIO BROS.',
  heading: 'One familiar world. Original instructions.',
  description:
    'Play runs the original cartridge reset and title sequence. Press Enter to start. Move with the arrows; Z or Space jumps, X runs or fires.',
  help: [
    'Enter: Start / pause. Right Shift: Select.',
    'Arrow keys: NES directional pad.',
    'Z or Space: A / jump. X: B / run or fire.',
  ],
  example:
    'A recorded sequence starts the original game, walks, runs and jumps. It is a bounded control demonstration, not a completed world.',
});
