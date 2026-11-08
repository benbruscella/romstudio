import { buildNesGame } from '../../../../analysis/nes.js';
import type { StartupOptions } from '../../../../startup.js';
const start = [
  { frame: 0, buttons: 0 },
  ...[180, 360, 540, 720, 900].flatMap((frame) => [
    { frame, buttons: 8 },
    { frame: frame + 5, buttons: 0 },
  ]),
];
export const tetrisStudy = {
  id: 'tetris',
  title: 'Tetris',
  routes: [
    { id: 'title-idle', frames: 300, inputs: [{ frame: 0, buttons: 0 }] },
    {
      id: 'example',
      frames: 1400,
      inputs: [
        ...start,
        { frame: 970, buttons: 64 },
        { frame: 985, buttons: 0 },
        { frame: 1000, buttons: 1 },
        { frame: 1002, buttons: 0 },
        { frame: 1020, buttons: 32 },
        { frame: 1080, buttons: 0 },
        { frame: 1100, buttons: 128 },
        { frame: 1115, buttons: 0 },
        { frame: 1120, buttons: 2 },
        { frame: 1122, buttons: 0 },
        { frame: 1140, buttons: 32 },
        { frame: 1200, buttons: 0 },
        { frame: 1220, buttons: 8 },
        { frame: 1225, buttons: 0 },
        { frame: 1280, buttons: 8 },
        { frame: 1285, buttons: 0 },
        { frame: 1300, buttons: 32 },
        { frame: 1380, buttons: 0 },
      ],
    },
    {
      id: 'menu-options',
      frames: 900,
      inputs: [
        ...start.filter((event) => event.frame < 720),
        { frame: 600, buttons: 16 },
        { frame: 610, buttons: 0 },
        { frame: 630, buttons: 128 },
        { frame: 640, buttons: 0 },
        { frame: 660, buttons: 32 },
        { frame: 670, buttons: 0 },
        { frame: 720, buttons: 8 },
        { frame: 725, buttons: 0 },
        { frame: 780, buttons: 64 },
        { frame: 790, buttons: 0 },
      ].sort((a, b) => a.frame - b.frame),
    },
  ],
};
export const buildTetrisWeb = (
  options: StartupOptions & { onProgress?: (message: string) => void } = {},
) => buildNesGame(tetrisStudy, options);
