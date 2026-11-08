import { resolveGameKey } from './game-id.js';
import { join } from 'node:path';
import { gameBuildDirectory } from './paths.js';
import { buildSmbWeb } from './games/nes/smb/recovery/build.js';
import { buildTetrisWeb } from './games/nes/tetris/recovery/build.js';
import { repositoryRoot } from './paths.js';
import { bootElite } from './games/c64/elite/recovery/boot.js';
import { buildEliteWeb } from './games/c64/elite/recovery/build.js';
import { bootTrial } from './games/c64/lemmings/recovery/boot.js';
import { bootNebulus } from './games/c64/nebulus/recovery/boot.js';
import { buildWeb, defaultWebDirectory } from './games/c64/lemmings/recovery/build.js';
import { buildNebulusWeb, defaultNebulusWebDirectory } from './games/c64/nebulus/recovery/build.js';
import { bootSm64 } from './games/n64/sm64/recovery/boot.js';
import { buildSm64Web } from './games/n64/sm64/recovery/build.js';

/** Node-side composition root. Per-title launch/recovery belongs in its recipe
 * and adapter; the CLI uses the same build/serve flow for either title. */
export const titles = {
  'c64/elite': {
    system: 'c64',
    id: 'elite',
    name: 'Elite',
    boot: bootElite,
    bootStage: 'menu-reached',
    web: buildEliteWeb,
    webDirectory: gameBuildDirectory('c64/elite'),
    defaultPort: 4178,
    mediaDirectory: join(repositoryRoot, 'roms/c64/elite'),
    controls: 'N: new commander · Space: start/fire · F1: launch · Arrows: joystick',
  },
  'nes/smb': {
    system: 'nes',
    id: 'smb',
    name: 'Super Mario Bros.',
    web: buildSmbWeb,
    webDirectory: gameBuildDirectory('nes/smb'),
    defaultPort: 4176,
    mediaDirectory: join(repositoryRoot, 'roms/nes/smb'),
    controls: 'Arrows: D-pad · Enter: Start · Z/Space: A · X: B',
  },
  'nes/tetris': {
    system: 'nes',
    id: 'tetris',
    name: 'Tetris',
    web: buildTetrisWeb,
    webDirectory: gameBuildDirectory('nes/tetris'),
    defaultPort: 4177,
    mediaDirectory: join(repositoryRoot, 'roms/nes/testris'),
    controls: 'Arrows: D-pad · Enter: Start · Z/Space: A · X: B',
  },
  'n64/sm64': {
    system: 'n64',
    id: 'sm64',
    name: 'Super Mario 64 — Europe',
    boot: bootSm64,
    bootStage: 'first-rsp-task-reached',
    web: buildSm64Web,
    webDirectory: gameBuildDirectory('n64/sm64'),
    defaultPort: 4179,
    mediaDirectory: join(repositoryRoot, 'roms/n64/sm64'),
    controls: 'Arrows: stick · Enter: Start · Space/Z: A · X: B · Shift: Z/R · IJKL: camera',
  },
  'c64/lemmings': {
    system: 'c64',
    id: 'lemmings',
    name: 'Lemmings — Just dig!',
    boot: bootTrial,
    bootStage: 'menu-reached',
    web: buildWeb,
    webDirectory: defaultWebDirectory,
    defaultPort: 4173,
    mediaDirectory: join(repositoryRoot, 'roms/c64/lemmings'),
    controls: 'Arrow keys: cursor · 8: digger · Space: fire',
  },
  'c64/nebulus': {
    system: 'c64',
    id: 'nebulus',
    name: 'Nebulus — Tower Toppler',
    boot: bootNebulus,
    bootStage: 'menu-reached',
    web: buildNebulusWeb,
    webDirectory: defaultNebulusWebDirectory,
    defaultPort: 4174,
    mediaDirectory: join(repositoryRoot, 'roms/c64/nebulus'),
    controls: 'Arrow keys: joystick · Space: fire / jump',
  },
} as const;
export type TitleId = keyof typeof titles;

/** The agreed v0.1 release includes these six playable targets. A recipe or a
 * successful identification alone cannot satisfy the release requirement. */
export const requiredReleaseGames = [
  'c64/lemmings',
  'c64/nebulus',
  'c64/elite',
  'nes/smb',
  'nes/tetris',
  'n64/sm64',
] as const;

export function resolveTitleId(selection: string, system?: string): TitleId {
  return resolveGameKey(selection, Object.values(titles), system) as TitleId;
}
