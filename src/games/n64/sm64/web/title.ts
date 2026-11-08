import type { N64WebTitle } from '../../../../systems/n64/web/protocol.js';

export const title: N64WebTitle = {
  id: 'sm64',
  title: 'Super Mario 64',
  eyebrow: 'NINTENDO 64 / EUROPE',
  description:
    'Start at Mario’s original title screen. Press Enter to start, choose your language, then select a save file. This N64 recovery is still being tested.',
  actions: [
    { code: 'Enter', label: 'Enter · Start' },
    { code: 'Space', label: 'Space · A' },
    { code: 'KeyX', label: 'X · B' },
    { code: 'ShiftLeft', label: 'Left Shift · Z' },
    { code: 'ShiftRight', label: 'Right Shift · R' },
    { code: 'KeyI', label: 'I · C↑' },
    { code: 'KeyJ', label: 'J · C←' },
    { code: 'KeyK', label: 'K · C↓' },
    { code: 'KeyL', label: 'L · C→' },
  ],
  help: [
    'Arrows: analog stick / move the menu hand.',
    'Enter: Start / pause. Space or Z: A / jump. X: B.',
    'Left Shift: Z. Right Shift: R. I/J/K/L: camera C buttons.',
    'With no saves, this European version first opens language settings. Move the hand to Return and press A to reach file select.',
  ],
};
