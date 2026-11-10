import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameSources } from './game-library.js';
import { gameKey } from './game-id.js';
import { titles, resolveTitleId } from './titles.js';
import { pinnedMedia } from './media/library.js';

test('discovery keeps games with the same name on different systems separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'romstudio-game-versions-'));
  try {
    for (const system of ['nes', 'c64']) {
      const directory = join(root, system, 'tetris');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'recipe.json'),
        JSON.stringify({ system, title: 'Tetris', media: [] }),
      );
    }
    const sources = await gameSources(root);
    assert.deepEqual(
      sources.map((source) => source.key),
      ['c64/tetris', 'nes/tetris'],
    );
    assert.notEqual(sources[0]!.directory, sources[1]!.directory);
    await writeFile(
      join(root, 'c64/tetris/recipe.json'),
      JSON.stringify({ system: 'nes', media: [] }),
    );
    await assert.rejects(gameSources(root), /c64\/tetris.*system 'c64'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registered titles, recipe discovery and pinned media share qualified identities', async () => {
  const sources = await gameSources();
  assert.deepEqual(sources.map((source) => source.key).sort(), Object.keys(titles).sort());
  for (const [key, title] of Object.entries(titles)) {
    assert.equal(key, gameKey(title.system, title.id));
    assert.equal(resolveTitleId(title.id), key);
  }
  const media = await pinnedMedia();
  assert.equal(new Set(media.map((medium) => medium.id)).size, media.length);
  assert.ok(
    media.every(
      (medium) =>
        medium.game.startsWith(medium.system + '/') && medium.id.startsWith(medium.game + '/'),
    ),
  );
});
