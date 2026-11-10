import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootNebulus } from './boot.js';
import { repositoryRoot } from '../../../../paths.js';
import { Diagnostic } from '../../../../core.js';
test('Nebulus boots both original files to the menu, matches a static replay and tolerates alternate launch-workspace bytes', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/nebulus/TOWERTOP.D64'));
  } catch {
    t.skip('Private Nebulus media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-nebulus-'));
  try {
    const first = await bootNebulus({ outputDirectory: join(directory, 'normal') });
    assert.equal(first.report.status, 'menu-reached');
    assert.equal(first.report.verification.staticReplay, 'passed');
    assert.ok(first.report.verification.checks.every((check) => check.passed));
    assert.equal(first.report.state.pc, 0xab91);
    assert.equal(first.report.build.playable, false);
    assert.equal(first.report.verification.hardwareParity, 'unverified');
    assert.deepEqual(
      first.report.diskReads.map((read) => [read.name, read.start, read.bytes]),
      [['TOWER1', 0x801, 44477]],
    );
    assert.deepEqual(first.report.assets.publicAssets, []);
    await access(join(first.outputDirectory, 'menu.png'));
    assert.doesNotMatch(
      await readFile(join(first.outputDirectory, 'startup.js'), 'utf8'),
      /new Function|eval\(/,
    );
    const alternate = await bootNebulus({
      outputDirectory: join(directory, 'alternate'),
      workspaceFill: 255,
    });
    assert.equal(alternate.report.status, 'menu-reached');
    assert.deepEqual(alternate.report.state, first.report.state);
    assert.equal(alternate.report.hashes.gameRam, first.report.hashes.gameRam);
    assert.equal(alternate.report.hashes.display, first.report.hashes.display);
    const recipe = JSON.parse(
      await readFile(join(repositoryRoot, 'src/games/c64/nebulus/recipe.json'), 'utf8'),
    );
    recipe.media[0].sha256 = '0'.repeat(64);
    const path = join(directory, 'bad.json');
    await writeFile(path, JSON.stringify(recipe));
    await assert.rejects(
      bootNebulus({ recipePath: path }),
      (error: unknown) => error instanceof Diagnostic && error.code === 'MEDIA_HASH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
