import { buildNesGame } from '../../../../analysis/nes.js';
import type { StartupOptions } from '../../../../startup.js';
export const smbStudy = {
  id: 'smb',
  title: 'Super Mario Bros.',
  routes: [
    { id: 'title-idle', frames: 300, inputs: [{ frame: 0, buttons: 0 }] },
    {
      id: 'example',
      frames: 900,
      inputs: [
        { frame: 0, buttons: 0 },
        { frame: 180, buttons: 8 },
        { frame: 185, buttons: 0 },
        { frame: 300, buttons: 130 },
        { frame: 330, buttons: 131 },
        { frame: 350, buttons: 130 },
        { frame: 380, buttons: 131 },
        { frame: 405, buttons: 130 },
        { frame: 450, buttons: 0 },
        { frame: 520, buttons: 64 },
        { frame: 560, buttons: 65 },
        { frame: 580, buttons: 0 },
        { frame: 650, buttons: 8 },
        { frame: 655, buttons: 0 },
        { frame: 710, buttons: 8 },
        { frame: 715, buttons: 0 },
        { frame: 740, buttons: 128 },
        { frame: 770, buttons: 129 },
        { frame: 790, buttons: 128 },
        { frame: 850, buttons: 0 },
      ],
    },
    {
      id: 'mixed-directions',
      frames: 700,
      inputs: [
        { frame: 0, buttons: 0 },
        { frame: 180, buttons: 8 },
        { frame: 185, buttons: 0 },
        { frame: 300, buttons: 16 },
        { frame: 330, buttons: 32 },
        { frame: 360, buttons: 64 },
        { frame: 400, buttons: 128 },
        { frame: 430, buttons: 129 },
        { frame: 480, buttons: 130 },
        { frame: 530, buttons: 0 },
      ],
    },
  ],
};
export const buildSmbWeb = (
  options: StartupOptions & { onProgress?: (message: string) => void } = {},
) => buildNesGame(smbStudy, options);
