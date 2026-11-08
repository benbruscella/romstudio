import { join } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import { repositoryRoot } from '../../../../paths.js';
import { readN64Rom } from '../../../../media/n64.js';
import { sm64Entry } from '../code/startup.js';
import type { StartupOptions } from '../../../../startup.js';

export async function loadSm64Cartridge(options: StartupOptions) {
  const recipe = JSON.parse(
    (
      await readBounded(
        options.recipePath ?? join(repositoryRoot, 'src/games/n64/sm64/recipe.json'),
        65536,
      )
    ).toString(),
  ) as {
    media: { name: string; sha256: string }[];
    cartridge: { canonicalSha256: string };
  };
  const medium = recipe.media[0]!;
  const raw = await readBounded(
    join(options.mediaDirectory ?? join(repositoryRoot, 'roms/n64/sm64'), medium.name),
    67108864,
  );
  const rawSha256 = sha256(raw);
  if (rawSha256 !== medium.sha256) {
    throw new Diagnostic('MEDIA_HASH', 'SM64 raw cartridge identity does not match its recipe.');
  }
  const cartridge = readN64Rom(raw),
    canonicalSha256 = sha256(cartridge.rom);
  if (
    canonicalSha256 !== recipe.cartridge.canonicalSha256 ||
    cartridge.header.entryPoint !== sm64Entry.address
  ) {
    throw new Diagnostic('SM64_CARTRIDGE', 'Expected the pinned European revision-0 entry.');
  }
  return { ...cartridge, identity: { rawSha256, canonicalSha256, byteOrder: cartridge.byteOrder } };
}
