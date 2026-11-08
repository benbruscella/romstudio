import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNebulusWeb } from './build.js';
import { startNebulusGame } from './game.js';
import { repositoryRoot } from '../../../../paths.js';
import { sha256 } from '../../../../core.js';
import { C64Player } from '../../../../systems/c64/player.js';
import { NebulusPlayer } from '../player.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';
import type { BrowserTitle } from '../../../../web/shell-types.js';
import type { Machine } from '../../../../runtime/mos6502.js';
import { renderC64 } from '../../../../systems/c64/render.js';
import { checkBrowserStart } from './browser-start.check.js';
test('first-tower launch retains the same game and pixels with alternate screen-tail fixture bytes', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/nebulus/TOWERTOP.D64'));
  } catch {
    t.skip('Private Nebulus media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-nebulus-start-'));
  try {
    const a = await startNebulusGame({ outputDirectory: join(directory, 'a') });
    const b = await startNebulusGame({ outputDirectory: join(directory, 'b'), paddingFill: 255 });
    assert.equal(a.player.machine.pc, 0x80ab);
    assert.equal(b.player.machine.pc, 0x80ab);
    assert.deepEqual(a.player.stats(), b.player.stats());
    assert.equal(sha256(a.player.display.pixels), sha256(b.player.display.pixels));
    assert.ok(a.player instanceof C64Player);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Nebulus exports a playable first tower through the common runtime, input protocol and shell', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/nebulus/TOWERTOP.D64'));
  } catch {
    t.skip('Private Nebulus media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-nebulus-web-'));
  try {
    const { manifest } = await buildNebulusWeb({ outputDirectory: directory });
    assert.equal(manifest.titleId, 'nebulus');
    assert.equal(manifest.build.playable, true);
    assert.equal(manifest.verification.referenceReplay, 'passed');
    assert.equal(manifest.example.completion, false);
    assert.equal(manifest.launch.checkpoint, 'title-screen');
    assert.equal(manifest.launch.start, 'space-or-fire');
    assert.equal(manifest.audio.sampleReplay, 'passed');
    assert.ok(manifest.audio.samples > 0);
    assert.equal(manifest.staticCoverage.kind, 'known-memory-envelope');
    assert.ok(manifest.staticCoverage.shapes > 0);
    assert.equal(manifest.staticCoverage.end, 0x10000);
    assert.ok(manifest.verification.checks.every((check) => check.passed));
    assert.equal(manifest.verification.hardwareParity, 'unverified');
    assert.equal(manifest.shell.kind, 'shared-browser-shell');
    assert.equal(manifest.shell.runtime, 'shared-c64-player');
    assert.ok(manifest.files['systems/c64/player.js']);
    assert.ok(manifest.files['games/c64/nebulus/web/title.js']);
    assert.equal(manifest.files['games/c64/lemmings/player.js'], undefined);
    assert.equal(manifest.files['games/c64/lemmings/web/title.js'], undefined);
    assert.equal(manifest.assets.policy, 'included-in-static-build');
    const menuCheckpoint = JSON.parse(
      await readFile(join(directory, 'checkpoint.json'), 'utf8'),
    ) as C64Checkpoint;
    const checkpoint = JSON.parse(
      await readFile(join(directory, 'analysis/gameplay-checkpoint.json'), 'utf8'),
    ) as C64Checkpoint;
    const { step } = (await import(
      pathToFileURL(join(directory, 'game-code/program.js')).href
    )) as { step: (s: Machine) => void };
    const player = new NebulusPlayer(checkpoint, step, () => ({ joystick: 247, keys: [] }));
    const firstRotation = player.stats().rotation;
    for (let frame = 0; frame < 100 && !player.gap; frame++) {
      player.advanceFrame();
    }
    assert.equal(player.gap, undefined);
    assert.notEqual(player.stats().rotation, firstRotation);
    // Regression: release Right (or Right+Fire) for Up after 30 PAL frames.
    // This enters $AFC1, which a held-Up coverage route never reached.
    for (const initial of [247, 231]) {
      let joystick = initial;
      const transition = new NebulusPlayer(checkpoint, step, () => ({ joystick, keys: [] }));
      for (let frame = 0; frame < 30; frame++) {
        transition.advanceFrame();
      }
      joystick = 254;
      for (let frame = 0; frame < 20; frame++) {
        transition.advanceFrame();
      }
      joystick = 255;
      for (let frame = 0; frame < 200 && !transition.gap; frame++) {
        transition.advanceFrame();
      }
      assert.equal(transition.gap, undefined, JSON.stringify({ initial, gap: transition.gap }));
    }
    let pins = 247;
    const mixed = new NebulusPlayer(checkpoint, step, () => ({ joystick: pins, keys: [] }));
    for (const [joystick, frames] of [
      [247, 30],
      [254, 20],
      [255, 50],
      [253, 110],
      [235, 60],
      [255, 100],
    ]) {
      pins = joystick!;
      for (let frame = 0; frame < frames! && !mixed.gap; frame++) {
        mixed.advanceFrame();
      }
    }
    assert.equal(mixed.gap, undefined, JSON.stringify(mixed.gap));
    // User route: Right, enter the first tunnel, Left, then Up again.
    // The second Up selected $9220 through a mutable call target and stopped.
    let tunnelPins = 247;
    const visited = new Set<number>();
    const tunnels = new NebulusPlayer(
      checkpoint,
      (machine) => {
        visited.add(machine.pc);
        step(machine);
      },
      () => ({ joystick: tunnelPins, keys: [] }),
    );
    for (const [joystick, frames] of [
      [247, 40],
      [254, 8],
      [255, 100],
      [251, 86],
      [254, 8],
      [255, 120],
    ]) {
      tunnelPins = joystick!;
      for (let frame = 0; frame < frames! && !tunnels.gap; frame++) {
        tunnels.advanceFrame();
      }
      assert.equal(tunnels.gap, undefined, JSON.stringify({ joystick, gap: tunnels.gap }));
      if (tunnels.controlFrames === 72) {
        assert.equal(tunnels.stats().rotation, 80, 'first tunnel reaches the other side');
        const r = tunnels.bus.vic.registers.slice();
        r[0x15] = 0;
        assert.equal(r[0x16]! & 7, 4, 'original four-pixel horizontal scroll');
        const background = renderC64({
          ram: tunnels.bus.bytes,
          known: tunnels.bus.known,
          colour: tunnels.bus.colour,
          registers: r,
          bank: (~tunnels.bus.cia2.read(0) & 3) * 0x4000,
        });
        const left = r[0]! - 24;
        assert.equal(left, 152, 'native sprite origin');
        // The 24px doorway must share the native sprite's horizontal span.
        // No player-position adjustment is allowed to compensate for graphics.
        for (const y of [100, 108]) {
          for (let x: number = left; x < left + 24; x++) {
            const offset: number = (y * 320 + x) * 4;
            assert.deepEqual(
              [...background.subarray(offset, offset + 3)],
              [0, 0, 0],
              `doorway ${x},${y}`,
            );
          }
        }
      }
    }
    assert.ok(visited.has(0x9220), 'second Up executes the recovered vertical transition');
    assert.equal(tunnels.stats().lives, 3);
    let jumpPins = 247;
    const jump = new NebulusPlayer(
      checkpoint,
      (machine) => {
        visited.add(machine.pc);
        step(machine);
      },
      () => ({ joystick: jumpPins, keys: [] }),
    );
    for (const [joystick, frames] of [
      [247, 30],
      [231, 8],
      [247, 30],
      [255, 30],
    ]) {
      jumpPins = joystick!;
      for (let frame = 0; frame < frames! && !jump.gap; frame++) {
        jump.advanceFrame();
      }
    }
    assert.equal(jump.gap, undefined, JSON.stringify(jump.gap));
    assert.ok(visited.has(0xf311), 'delayed jump executes the recovered sound branch');
    const { title } = (await import(
      pathToFileURL(join(directory, 'games/c64/nebulus/web/title.js')).href
    )) as { title: BrowserTitle };
    checkBrowserStart(title, menuCheckpoint, step);
    assert.doesNotMatch(
      await readFile(join(directory, 'game-code/program.js'), 'utf8'),
      /new Function|eval\(/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
