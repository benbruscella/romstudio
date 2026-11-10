/** Browser media identification for ROM Desk's /desk page (docs/DESK.md).
 * An exact recipe SHA-256 is an identity. A cartridge header, disk name or
 * filename is only a hint that names the game; it never makes a file
 * runnable. Nothing leaves the browser. */
export interface KnownMedia {
  game: string;
  system: string;
  name: string;
  title: string;
  sha256: string;
}
export interface MediaIdentity {
  kind: 'exact' | 'other-release' | 'unknown';
  file: string;
  sha256: string;
  format: string;
  hint?: string;
  match?: KnownMedia;
  /** For other-release: the game the hint points to. */
  game?: { id: string; system: string; title: string };
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** N64 header name, normalising the three common byte orders. */
function n64Name(bytes: Uint8Array): string | undefined {
  if (bytes.length < 0x40) {
    return undefined;
  }
  const word = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const order =
    word === 0x80371240
      ? [0, 1, 2, 3]
      : word === 0x37804012
        ? [1, 0, 3, 2]
        : word === 0x40123780
          ? [3, 2, 1, 0]
          : undefined;
  if (!order) {
    return undefined;
  }
  let name = '';
  for (let offset = 0x20; offset < 0x34; offset++) {
    const base = offset & ~3,
      byte = bytes[base + order[offset & 3]!]!;
    name += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ' ';
  }
  return name.trim();
}

/** D64 disk name from the directory header (track 18, sector 0). */
function d64Name(bytes: Uint8Array): string | undefined {
  if (![174848, 175531, 196608, 197376].includes(bytes.length)) {
    return undefined;
  }
  const header = 0x16500 + 0x90;
  let name = '';
  for (let offset = 0; offset < 16; offset++) {
    const byte = bytes[header + offset]!;
    if (byte === 0xa0) {
      break;
    }
    name += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ' ';
  }
  return name.trim();
}

export function mediaFormat(bytes: Uint8Array): { format: string; hint?: string } {
  const n64 = n64Name(bytes);
  if (n64 !== undefined) {
    return { format: 'N64 cartridge', hint: n64 };
  }
  if (bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a) {
    return { format: 'iNES cartridge' };
  }
  const d64 = d64Name(bytes);
  if (d64 !== undefined) {
    return { format: 'C64 D64 disk', hint: d64 };
  }
  return { format: 'unrecognised binary' };
}

export function identifyMedia(
  file: string,
  bytes: Uint8Array,
  sha256: string,
  known: readonly KnownMedia[],
): MediaIdentity {
  const { format, hint } = mediaFormat(bytes);
  const match = known.find((item) => item.sha256 === sha256);
  if (match) {
    return { kind: 'exact', file, sha256, format, ...(hint ? { hint } : {}), match };
  }
  // A hint names a game only when its words contain the game's title words
  // (for example "SUPER MARIO 64" or a filename "lemmings_side_a.d64").
  const words = normalise([hint ?? '', file.replace(/\.[^.]+$/, '')].join(' '));
  // Catalog titles carry subtitles ("Super Mario 64 — Europe"); match the core.
  const game = known.find((item) => {
    const title = normalise(item.title.split(/\s[—–-]\s|:\s/)[0]!);
    return title.length >= 4 && ` ${words} `.includes(` ${title} `);
  });
  return {
    kind: game ? 'other-release' : 'unknown',
    file,
    sha256,
    format,
    ...(hint ? { hint } : {}),
    ...(game ? { game: { id: game.game, system: game.system, title: game.title } } : {}),
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
