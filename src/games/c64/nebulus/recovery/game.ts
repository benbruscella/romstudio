import { join } from 'node:path';
import { bootNebulus } from './boot.js';
import { Diagnostic } from '../../../../core.js';
import { recover } from '../../../../transpiler/recover.js';
import { captureC64 } from '../../../../systems/c64/snapshot.js';
import { NebulusPlayer } from '../player.js';
import type { C64Controls } from '../../../../systems/c64/input.js';
import type { StartupOptions } from '../../../../startup.js';

export const nebulusExtensions = [0x3c, 0xfc];
export const NEBULUS_FIRST_TOWER = 0x80ab;
/** Reach actual gameplay with original joystick input. The small screen-tail
 * fixture covers $07E8–$0800, which the drawing code reads before replacing it.
 * Tests vary it between $00/$FF and compare the first tower and player state. */
export async function startNebulusGame(options: StartupOptions & { paddingFill?: number } = {}) {
  const boot = await bootNebulus({
    ...options,
    ...(options.outputDirectory ? { outputDirectory: join(options.outputDirectory, 'boot') } : {}),
  });
  if (boot.report.status !== 'menu-reached') {
    throw new Diagnostic('NEBULUS_START', 'Verified menu startup is required.');
  }
  const padding = options.paddingFill ?? 0;
  if (!Number.isInteger(padding) || padding < 0 || padding > 255) {
    throw new Diagnostic('LAUNCH_FIXTURE', 'Screen-tail fixture must be a byte.');
  }
  const player = new NebulusPlayer(
    boot.checkpoint,
    () => {},
    (frame) => ({ joystick: frame >= 5 && frame <= 8 ? 239 : 255, keys: [] }),
  );
  for (let address = 0x7e8; address < 0x801; address++) {
    player.bus.seed(address, padding);
  }
  const menuCheckpoint = captureC64(player.bus, player.machine);
  const trace = recover(player.machine, {
    stopAt: NEBULUS_FIRST_TOWER,
    maxInstructions: 6000000,
    maxVariants: 50000,
    maxBoundaryOperations: 100000,
    undocumentedOpcodes: nebulusExtensions,
    onFetch: (instruction) => player.bus.observe(instruction),
    onBoundary: () => player.boundary(),
  });
  if (trace.stop !== 'checkpoint') {
    throw new Diagnostic('NEBULUS_START', JSON.stringify(trace.gap ?? trace.stop));
  }
  player.machine.guard(NEBULUS_FIRST_TOWER, [0x20, 0x21, 0x83]);
  return {
    boot,
    player,
    trace,
    menuCheckpoint,
    checkpoint: captureC64(player.bus, player.machine),
    launchFixture: { start: 0x7e8, end: 0x801, fill: padding },
  };
}
export interface NebulusRoute {
  id: string;
  frames: number;
  controls(frame: number): C64Controls;
}
const route = (id: string, joystick: (frame: number) => number, frames = 800): NebulusRoute => ({
  id,
  frames,
  controls: (frame) => ({ joystick: joystick(frame), keys: [] }),
});
export const nebulusRoutes: readonly NebulusRoute[] = [
  route(
    'example',
    (frame) =>
      [255, 251, 235, 251, 239, 250, 231, 245, 247, 254, 253, 255][Math.floor((frame - 1) / 40)] ??
      255,
    480,
  ),
  route('idle-and-respawn', () => 255),
  route('walk-right', () => 247),
  route('walk-left', () => 251),
  route('jump-right', (frame) => (frame % 80 < 40 ? 231 : 247)),
  route('jump-left', (frame) => (frame % 80 < 40 ? 235 : 251)),
  route('standing-fire', (frame) => (frame % 20 < 10 ? 239 : 255)),
  route('up', () => 254),
  route('down', () => 253),
  route('diagonals', (frame) => [246, 250, 245, 249][Math.floor((frame - 1) / 100) % 4]!),
  route(
    'direction-reversals',
    (frame) => [247, 251, 231, 235, 254, 253, 239, 255][Math.floor((frame - 1) / 7) % 8]!,
  ),
  // A held-Up route never visits the door/lift transition after movement.
  // $AFC1 was missed when right was released in favour of Up near the start.
  ...[247, 251, 231, 235].flatMap((direction) =>
    [12, 14, 16].map((turn) =>
      route(
        `move-${direction}-then-up-${turn}`,
        (frame) => (frame <= turn ? direction : frame <= turn + 12 ? 254 : 255),
        260,
      ),
    ),
  ),
  ...[1, 10, 50].map((delay) =>
    route(
      `idle-then-up-${delay}`,
      (frame) => (frame <= delay ? 255 : frame <= delay + 10 ? 254 : 255),
      260,
    ),
  ),
  route(
    'up-down-jump-transition',
    (frame) =>
      frame <= 14
        ? 247
        : frame <= 24
          ? 254
          : frame <= 49
            ? 255
            : frame <= 104
              ? 253
              : frame <= 134
                ? 235
                : 255,
    400,
  ),
  // First tunnel rotates $47 from $10 to $50. Walk left to the next
  // doorway/lift, then Up selects the vertical routine at $9220. Its target
  // is selected through mutable call operands, outside direct CFG coverage.
  route(
    'two-tunnels',
    (frame) =>
      frame <= 18
        ? 247
        : frame <= 22
          ? 254
          : frame <= 72
            ? 255
            : frame <= 115
              ? 251
              : frame <= 123
                ? 254
                : 255,
    280,
  ),
  // Fire must follow walking to exercise the original jump sound. Starting
  // with direction+fire held missed the sound-driver branch at $F311.
  route(
    'walk-then-jump-sound',
    (frame) => (frame <= 13 ? 247 : frame <= 17 ? 231 : frame <= 37 ? 247 : 255),
    260,
  ),
];
