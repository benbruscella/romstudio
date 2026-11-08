import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';
import { gameSources } from '../game-library.js';
import { D64Image, d64Reader } from '../media/d64.js';
import { basicSys } from '../media/basic.js';
import { n64ByteOrder, readN64Rom } from '../media/n64.js';

interface RecipeMatch {
  game: string;
  title: string;
  system: string;
  role: string;
  sha256: string;
}
export interface Identification {
  path: string;
  bytes: number;
  sha256: string;
  format: 'd64' | 'ines' | 'n64-cartridge' | 'commodore-prg' | 'raw-nes-chip' | 'binary';
  systems: string[];
  evidence: string[];
  matches: RecipeMatch[];
  details: Record<string, unknown>;
}

/** A filename is a hint, a valid header is evidence, and an exact recipe hash
 * is an identity. Keeping these distinct avoids guessing a CPU from raw bytes. */
export function identifyBytes(
  path: string,
  bytes: Uint8Array,
  known: readonly RecipeMatch[] = [],
): Identification {
  const hash = sha256(bytes),
    matches = known.filter((item) => item.sha256 === hash);
  const result: Identification = {
    path,
    bytes: bytes.length,
    sha256: hash,
    format: 'binary',
    systems: [],
    evidence: [],
    matches,
    details: {},
  };
  if (n64ByteOrder(bytes)) {
    const cartridge = readN64Rom(bytes);
    result.format = 'n64-cartridge';
    result.systems = ['n64'];
    result.details = {
      ...cartridge.header,
      byteOrder: cartridge.byteOrder,
      canonicalSha256: sha256(cartridge.rom),
    };
    result.evidence.push(
      'N64 cartridge signature and header, normalized for big-endian reads. Header CRC fields are reported, not independently verified.',
    );
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a
  ) {
    if (bytes.length < 16) {
      throw new Diagnostic('INES_HEADER', `Truncated iNES header: ${path}`);
    }
    const nes2 = (bytes[7]! & 12) === 8;
    if (nes2) {
      result.details = { header: 'NES 2.0', supported: false };
      result.evidence.push('NES 2.0 signature; this reader does not interpret its extended sizes.');
    } else {
      const prgBytes = bytes[4]! * 16384,
        chrBytes = bytes[5]! * 8192,
        trainerBytes = bytes[6]! & 4 ? 512 : 0;
      if (bytes.length !== 16 + trainerBytes + prgBytes + chrBytes) {
        throw new Diagnostic('INES_LENGTH', `Chip lengths do not match the iNES header: ${path}`);
      }
      result.details = {
        mapper: (bytes[6]! >>> 4) | (bytes[7]! & 0xf0),
        prgBytes,
        chrBytes,
        trainerBytes,
        mirroring: bytes[6]! & 8 ? 'four-screen' : bytes[6]! & 1 ? 'vertical' : 'horizontal',
        battery: !!(bytes[6]! & 2),
        timingHint: bytes[9]! & 1 ? 'PAL' : 'NTSC',
      };
      result.evidence.push(
        'Valid iNES signature and declared chip lengths. Timing is a header hint.',
      );
    }
    result.format = 'ines';
    result.systems = ['nes'];
  } else if (d64Reader.probe(bytes)) {
    const disk = new D64Image(bytes);
    result.format = 'd64';
    result.systems = ['c64', 'other Commodore systems'];
    result.evidence.push(
      'Valid D64 geometry and directory. A disk image alone does not identify its computer.',
    );
    result.details = {
      name: disk.name,
      tracks: disk.tracks,
      sectors: disk.sectorCount,
      entries: disk.entries,
    };
  } else if (
    matches.some((match) => match.system === 'nes' && ['prg', 'chr'].includes(match.role))
  ) {
    result.format = 'raw-nes-chip';
    result.systems = ['nes'];
    result.evidence.push(
      'Exact SHA-256 match to a pinned NES chip. Board wiring comes from its game recipe.',
    );
  } else if (extname(path).toLowerCase() === '.prg' && bytes.length >= 3) {
    const start = bytes[0]! | (bytes[1]! << 8);
    if (start + bytes.length - 2 > 65536) {
      throw new Diagnostic('PRG_LENGTH', `PRG data exceeds the 16-bit address space: ${path}`);
    }
    result.format = 'commodore-prg';
    result.systems = ['Commodore systems'];
    result.details = { loadAddress: start, payloadBytes: bytes.length - 2 };
    result.evidence.push(
      'PRG filename and two-byte load address; this does not establish a CPU or system.',
    );
    const memory = new Uint8Array(65536);
    memory.set(bytes.subarray(2), start);
    try {
      result.details.basicSys = basicSys(memory, start);
    } catch {
      /* Entry detection is optional identification evidence. */
    }
  }
  if (matches.length) {
    result.systems = [...new Set(matches.map((match) => match.system))];
    result.evidence.push('Exact SHA-256 match to the listed game recipe.');
  }
  if (!result.evidence.length) {
    result.evidence.push(
      'No recognised header or pinned recipe. Raw binary bytes have no universal system identifier.',
    );
  }
  return result;
}

async function recipeIdentities(): Promise<RecipeMatch[]> {
  const identities: RecipeMatch[] = [];
  for (const { key, recipe } of await gameSources()) {
    for (const medium of recipe.media) {
      identities.push({
        game: key,
        title: recipe.title,
        system: recipe.system,
        role: medium.role ?? 'disk',
        sha256: medium.sha256,
      });
    }
  }
  return identities;
}

export async function identifyPaths(paths: readonly string[]): Promise<Identification[]> {
  if (!paths.length) {
    throw new Diagnostic('CLI_INPUT', 'Supply a ROM file or folder. Try: roms identify roms');
  }
  const known = await recipeIdentities(),
    files: string[] = [],
    seen = new Set<string>();
  const visit = async (input: string, depth: number): Promise<void> => {
    const path = resolve(input);
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    if (seen.size > 4096 || depth > 16) {
      throw new Diagnostic(
        'IDENTIFY_LIMIT',
        'Limit identification to 4,096 entries and 16 folder levels.',
      );
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Diagnostic(
        'INPUT_TYPE',
        `Identify a regular file or folder, rather than a symbolic link: ${input}`,
      );
    }
    if (stat.isDirectory()) {
      for (const item of (await readdir(path)).sort()) {
        if (!item.startsWith('.')) {
          await visit(join(path, item), depth + 1);
        }
      }
    } else if (stat.isFile()) {
      files.push(path);
    } else {
      throw new Diagnostic('INPUT_TYPE', `Expected a regular file: ${input}`);
    }
  };
  for (const path of paths) {
    await visit(path, 0);
  }
  const results: Identification[] = [];
  for (const path of files) {
    results.push(identifyBytes(path, await readBounded(path, 67108864), known));
  }
  return results;
}

export function describeIdentification(results: readonly Identification[]): string {
  return (
    results
      .map((item) => {
        const lines = [
          basename(item.path),
          `  Format: ${item.format} · ${item.bytes.toLocaleString('en-US')} bytes`,
          `  System: ${item.systems.join(' / ') || 'unknown'}`,
        ];
        if (item.matches.length) {
          lines.push(
            `  Game: ${[...new Set(item.matches.map((match) => match.title))].join(' / ')} (${item.matches.map((match) => match.role).join(', ')})`,
          );
        }
        if (item.format === 'd64') {
          lines.push(
            `  Disk: ${item.details.name} · ${item.details.tracks} tracks · ${(item.details.entries as unknown[]).length} files`,
          );
        }
        if (item.format === 'ines') {
          lines.push(
            `  Board: mapper ${item.details.mapper ?? 'unknown'} · PRG ${item.details.prgBytes ?? '?'} · CHR ${item.details.chrBytes ?? '?'} bytes`,
          );
        }
        if (item.format === 'n64-cartridge') {
          lines.push(
            `  Cartridge: ${item.details.title} · ${item.details.gameCode} · revision ${item.details.revision}`,
            `  Byte order: ${item.details.byteOrder} · CPU entry: $${Number(item.details.entryPoint).toString(16).toUpperCase().padStart(8, '0')}`,
            `  Canonical SHA-256: ${item.details.canonicalSha256}`,
          );
        }
        if (item.format === 'commodore-prg') {
          lines.push(
            `  Load: $${(item.details.loadAddress as number).toString(16).padStart(4, '0')}`,
          );
        }
        lines.push(
          `  SHA-256: ${item.sha256}`,
          ...item.evidence.map((evidence) => `  ${evidence}`),
        );
        return lines.join('\n');
      })
      .join('\n\n') + '\n'
  );
}
