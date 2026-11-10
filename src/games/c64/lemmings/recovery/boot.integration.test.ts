import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTrial } from './boot.js';
import { repositoryRoot } from '../../../../paths.js';
test('the real three-disk trial starts from the PRG and reaches the menu with twelve N replies', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/lemmings/LEMMING0.D64'));
  } catch {
    t.skip('Private trial media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-menu-'));
  try {
    const result = await bootTrial({ outputDirectory: directory });
    assert.equal(result.report.status, 'menu-reached');
    assert.equal(result.report.state.pc, 0x91c4);
    assert.equal(result.report.inputs.filter((input) => input.kind === 'trainer-no').length, 12);
    assert.deepEqual(
      result.report.diskReads.map((read) => read.name),
      ['ID', 'IE', 'PA', 'CA', 'CB'],
    );
    assert.equal(result.report.diskReads.at(-1)!.blocks.length, 2);
    assert.equal(result.report.verification.hardwareParity, 'unverified');
    assert.equal(result.report.verification.gameplay, 'unverified');
    assert.ok(result.report.hashes.display);
    await access(join(result.outputDirectory, 'menu.png'));
    // A second execution is evidence of deterministic replay, not hardware parity.
    const replay = await bootTrial({ outputDirectory: directory });
    assert.deepEqual(replay.report.state, result.report.state);
    assert.deepEqual(replay.report.hashes, result.report.hashes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
