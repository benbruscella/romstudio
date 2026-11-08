import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSm64, bootSm64Entry } from './boot.js';
import { bootSm64Graphics } from './graphics.js';
import { repositoryRoot } from '../../../../paths.js';

test('SM64 EU original MIPS entry matches static translation and its named BSS interpretation', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/n64/sm64/nus-nsmp-0.u1'));
  } catch {
    t.skip('The pinned SM64 cartridge is not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-sm64-entry-'));
  try {
    const { report } = await bootSm64Entry({ outputDirectory: directory });
    assert.ok(report.verification.checks.every((check) => check.passed));
    assert.equal(report.state.pc, 0x80242e80);
    assert.equal(report.state.instructions, 120449);
    assert.equal(report.verification.gameplay, 'unverified');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SM64 EU graphics handoffs replay buffer clears, texture samples and rendered framebuffer pixels', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/n64/sm64/nus-nsmp-0.u1'));
  } catch {
    t.skip('The pinned SM64 cartridge is not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-sm64-graphics-'));
  try {
    const { report } = await bootSm64Graphics({ outputDirectory: directory, stage: 'frame' });
    assert.equal(report.status, 'first-textured-task-rendered');
    assert.ok(report.firstGraphics);
    assert.ok(report.firstTexture);
    for (const verification of [
      report.cpuStartupVerification,
      report.audioVerification,
      report.verification,
      report.firstGraphics.verification,
      report.firstTexture.verification,
    ]) {
      assert.ok(verification.checks.every((check) => check.passed));
    }
    assert.equal(report.firstGraphics.instructions, 4449);
    assert.equal(report.firstGraphics.display.fullSyncs, 1);
    assert.equal(report.firstGraphics.display.fills.length, 4);
    assert.equal(report.firstTexture.instructions, 8602);
    assert.equal(report.firstTexture.boundary.opcode, 15);
    assert.equal(report.firstTexture.boundary.bytes.length, 176);
    assert.equal(report.firstTexture.boundary.taskComplete, false);
    assert.equal(report.firstTexture.texture.texels, 1024);
    assert.ok('image' in report.graphics);
    assert.equal(report.graphics.instructions, 373418);
    assert.equal(report.graphics.display.triangles.length, 282);
    assert.equal(report.graphics.image.nonblackPixels, 16);
    assert.equal(report.graphics.verification.pixelPrecision, 'functional-approximation');
    assert.equal(report.capture.referenceReplayAfterFirstAudioRequest, 'unverified');
    assert.equal(report.verification.gameplay, 'unverified');
    await access(join(directory, 'startup/source-study/game-code/rsp-graphics/program.ts'));
    await access(join(directory, 'startup/source-study/game-code/rsp-textures/program.ts'));
    await access(join(directory, 'startup/source-study/game-code/rsp-render/program.ts'));
    await access(join(directory, 'first-texture.png'));
    await access(join(directory, 'first-frame.png'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SM64 EU CPU startup replays through its first RSP task without substituting game routines', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/n64/sm64/nus-nsmp-0.u1'));
  } catch {
    t.skip('The pinned SM64 cartridge is not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-sm64-startup-'));
  try {
    const { report } = await bootSm64({ outputDirectory: directory });
    assert.equal(report.status, 'first-rsp-task-reached');
    assert.ok(report.verification.checks.every((check) => check.passed));
    assert.equal(report.boundary.kind, 'rsp-execution');
    assert.ok([1, 2].includes(report.boundary.task[0]!));
    assert.ok(report.startup.shapes > 1000);
    assert.ok(report.startup.cartridgeTransfers.length > 0);
    assert.equal(report.verification.gameplay, 'unverified');
    assert.equal(report.fixture.consoleReset, 'unverified');
    assert.equal(report.audio.status, 'first-rsp-audio-task-completed');
    assert.equal(report.audio.instructions, 22566);
    assert.ok(report.audio.verification.checks.every((check) => check.passed));
    assert.equal(report.audio.namedMixer.samples, 320);
    assert.equal(report.audio.namedMixer.cases.length, 15);
    assert.equal(report.audio.verification.gameMusic, 'unverified');
    await access(join(directory, 'source-study/game-code/program.ts'));
    await access(join(directory, 'source-study/game-code/rsp/program.ts'));
    await access(join(directory, 'sp-state.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
