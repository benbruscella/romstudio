import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Machine } from '../../../../runtime/mos6502.js';
import { buildWeb } from './build.js';
import { repositoryRoot } from '../../../../paths.js';
import { LemmingsPlayer } from '../player.js';
import { sampleTerrain } from '../code/level-data.js';
import { type RecordedControls } from '../../../../systems/c64/input.js';
import type { BrowserTitle } from '../../../../web/shell-types.js';
import type { C64Checkpoint } from '../../../../systems/c64/snapshot.js';

test('a static first-level export completes the recorded original-input route with identical state and raster output', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/lemmings/LEMMING0.D64'));
  } catch {
    t.skip('Private trial media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-web-'));
  try {
    const result = await buildWeb({ outputDirectory: directory });
    assert.equal(result.manifest.verification.referenceReplay, 'passed');
    assert.equal(result.manifest.titleId, 'lemmings');
    assert.equal(result.manifest.shell.runtime, 'shared-c64-player');
    assert.ok(result.manifest.files['systems/c64/player.js']);
    assert.equal(result.manifest.files['games/c64/nebulus/player.js'], undefined);
    assert.ok(result.manifest.verification.checks.every((check) => check.passed));
    assert.deepEqual(result.manifest.verification.result, {
      won: true,
      rescued: 6,
      total: 10,
      percent: 60,
      required: 50,
      reason: 9,
    });
    assert.equal(result.manifest.build.playable, true);
    assert.equal(result.manifest.example.completion, true);
    assert.equal(result.manifest.audio.sampleReplay, 'passed');
    assert.ok(result.manifest.audio.samples > 0);
    assert.equal(result.manifest.staticCoverage.kind, 'known-memory-envelope');
    assert.equal(result.manifest.verification.hardwareParity, 'unverified');
    assert.deepEqual(
      result.manifest.cursorCoverage.map((coverage) => ({
        id: coverage.id,
        bounds: coverage.bounds,
        replay: coverage.staticReplay,
      })),
      [
        {
          id: 'cursor-default',
          bounds: { minX: 4, maxX: 83, minY: 17, maxY: 167 },
          replay: 'passed',
        },
        {
          id: 'cursor-digger',
          bounds: { minX: 4, maxX: 83, minY: 17, maxY: 167 },
          replay: 'passed',
        },
      ],
    );
    assert.equal(result.manifest.assets.policy, 'included-in-static-build');
    const app = await readFile(join(directory, 'game-code/program.js'), 'utf8');
    assert.doesNotMatch(app, /new Function|eval\(/);
    assert.doesNotMatch(
      await readFile(join(directory, 'systems/c64.js'), 'utf8'),
      /core\.js|node:/,
    );
    await access(join(directory, 'game-code/program.ts'));
    await access(join(directory, 'index.html'));
    // Regression: the old export stopped at $17E8 after 40 frames of Down.
    // Exercise the delivered module with video capture, including diagonals,
    // rather than accepting recovery's ability to compile the missing branch.
    const checkpoint = JSON.parse(
      await readFile(join(directory, 'checkpoint.json'), 'utf8'),
    ) as C64Checkpoint;
    const { step } = (await import(
      pathToFileURL(join(directory, 'game-code/program.js')).href
    )) as { step(machine: Machine): void };
    // Independent display check: compare terrain-only columns with the
    // original game's terrain lookup, including every sprite-strip boundary.
    // Entrance, exit, lemming and cursor overlays lie outside this rectangle.
    const preview = new LemmingsPlayer(checkpoint, step, () => ({
      joystick: 255,
      key8: false,
      deleteKey: false,
    }));
    preview.advanceFrame();
    preview.advanceFrame();
    assert.equal(preview.gap, undefined);
    const scroll = (preview.bus.bytes[0x40d]! << 2) | (preview.bus.bytes[0x40c]! >>> 1);
    const terrainColours = [0x000000, 0x433900, 0x588d43, 0x6f4f25];
    for (let y = 16; y < 160; y++) {
      for (let x = 160; x <= 210; x += 2) {
        const pair = sampleTerrain(preview.bus, scroll + (x - 54) / 2, y + 8).pair,
          colour = terrainColours[pair]!;
        const at = (y * 320 + x) * 4;
        assert.deepEqual(
          [...preview.display.pixels.subarray(at, at + 4)],
          [colour >>> 16, (colour >>> 8) & 255, colour & 255, 255],
          `terrain pixel ${x},${y}`,
        );
      }
    }
    const events = JSON.parse(
      await readFile(join(directory, 'example.json'), 'utf8'),
    ) as RecordedControls[];
    assert.ok(events.every((event) => Array.isArray(event.keys) && !('key8' in event)));
    const { title } = (await import(
      pathToFileURL(join(directory, 'games/c64/lemmings/web/title.js')).href
    )) as { title: BrowserTitle };
    const shellPlayer = title.create(checkpoint, step, () => ({ pressed: [] }), events);
    for (let frame = 0; frame < 6000 && !shellPlayer.gap && !shellPlayer.result; frame++) {
      shellPlayer.advanceFrame();
    }
    assert.equal(shellPlayer.gap, undefined);
    assert.equal(shellPlayer.stats().stock, 9);
    assert.equal(shellPlayer.result?.won, true);
    assert.equal(shellPlayer.stats().rescued, '6/10');
    for (const joystick of [253, 249, 245]) {
      const player = new LemmingsPlayer(checkpoint, step, () => ({
        joystick,
        key8: false,
        deleteKey: false,
      }));
      for (let frame = 0; frame < 200 && !player.gap; frame++) {
        player.advanceFrame();
      }
      assert.equal(player.gap, undefined, JSON.stringify({ joystick, gap: player.gap }));
      assert.equal(player.bus.bytes[0xb8], 167, `bottom clamp with joystick ${joystick}`);
    }
    let pins = 247,
      digger = false;
    const mixed = new LemmingsPlayer(checkpoint, step, () => ({
      joystick: pins,
      key8: digger,
      deleteKey: false,
    }));
    for (const [joystick, frames] of [
      [247, 30],
      [254, 20],
      [255, 50],
      [253, 110],
      [235, 60],
      [255, 100],
    ]) {
      pins = joystick!;
      digger = frames === 110;
      for (let frame = 0; frame < frames! && !mixed.gap; frame++) {
        mixed.advanceFrame();
      }
    }
    assert.equal(mixed.gap, undefined, JSON.stringify(mixed.gap));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
