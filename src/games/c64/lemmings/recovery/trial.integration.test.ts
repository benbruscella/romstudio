import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryRoot } from '../../../../paths.js';
import { runTrial } from './trial.js';
import { Diagnostic } from '../../../../core.js';
test('real trial checks all supplied media, reproduces the bootstrap, and retains explicit gaps', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/c64/lemmings/LEMMING0.D64'));
  } catch {
    t.skip('Private trial media are not installed.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-trial-'));
  try {
    const result = await runTrial({ outputDirectory: directory });
    assert.equal(result.verification.status, 'passed');
    assert.equal(result.verification.state.pc, 0x340);
    assert.equal(result.verification.state.instructions, 1030);
    assert.equal(result.verification.state.cycles, 3656);
    assert.deepEqual(
      result.inventory.map((d) => d.entries.length),
      [29, 55, 55],
    );
    assert.equal(result.manifest.build.playable, false);
    assert.equal(result.manifest.verification.hardwareParity, 'unverified');
    assert.ok(result.manifest.gaps.some((g) => g.kind === 'next-stage'));
    const assembly = await readFile(join(directory, 'bootstrap.asm'), 'utf8');
    assert.ok(assembly.startsWith('080C  A0 00     LDY #$00\n080E  78        SEI\n'));
    assert.ok(assembly.endsWith('0820  4C 40 03  JMP $0340\n'));
    const relocated = await readFile(join(directory, 'relocated.asm'), 'utf8');
    assert.ok(relocated.startsWith('0340  B9 27 42  LDA $4227,Y'));
    const repeated = await runTrial({ outputDirectory: directory });
    assert.equal(repeated.manifest.buildId, result.manifest.buildId);
    assert.deepEqual(repeated.verification, result.verification);
    const recipe = JSON.parse(
      await readFile(join(repositoryRoot, 'src/games/c64/lemmings/recipe.json'), 'utf8'),
    );
    recipe.media[0].sha256 = '0'.repeat(64);
    const path = join(directory, 'bad-recipe.json');
    await writeFile(path, JSON.stringify(recipe));
    await assert.rejects(
      runTrial({ recipePath: path, outputDirectory: join(directory, 'bad') }),
      (e: unknown) => e instanceof Diagnostic && e.code === 'MEDIA_HASH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
