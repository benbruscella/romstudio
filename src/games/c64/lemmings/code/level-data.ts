import { ExecutionGap } from '../../../../runtime/mos6502.js';

export interface RecoveredMemory {
  bytes: Uint8Array;
  known: Uint8Array;
}

function read(memory: RecoveredMemory, address: number): number {
  address &= 65535;
  if (!memory.known[address]) {
    throw new ExecutionGap('level-memory', address, 'Level decoding needs a recovered byte.');
  }
  return memory.bytes[address]!;
}
export { read as readLevelByte };

/** This release uses a mixed screen alphabet: 1–26 are lowercase letters,
 * while $41–$5A retain uppercase letters. It is not an ASCII string. */
export function levelText(codes: readonly number[]): string {
  return codes
    .map((code) => {
      if (code >= 1 && code <= 26) {
        return String.fromCharCode(96 + code);
      }
      if (code >= 32 && code <= 90) {
        return String.fromCharCode(code);
      }
      throw new Error(`Unsupported level text code ${code}.`);
    })
    .join('')
    .trim();
}

/** Names are explanatory, not recovered author symbols. The two level files
 * share this header; address comments identify the instructions using it. */
export function decodeLevelHeader(memory: RecoveredMemory) {
  const byte = (offset: number): number => read(memory, 0xe000 + offset);
  const array = (offset: number, length: number): number[] =>
    Array.from({ length }, (_, index) => byte(offset + index));
  const decimal = (offset: number, length: number): number => {
    const text = String.fromCharCode(...array(offset, length)).trim();
    if (!/^\d+$/.test(text)) {
      throw new Error('Level display number is not decimal.');
    }
    return Number(text);
  };
  const positions = (offset: number, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const at = offset + index * 3;
      return { x: byte(at) * 256 + byte(at + 1), y: byte(at + 2) };
    }).filter((position) => position.y !== 255);
  return {
    name: levelText(array(0x19, 30)),
    lemmingCount: byte(0x39), // $1E0B–$1E11 caps the number spawned.
    rescuePercentShown: decimal(0x3a, 2),
    releaseRateShown: decimal(0x3d, 3),
    releaseIntervalIndex: byte(0x3c), // $10EE; indexes tables at $4FB8/$4FD0/$4FE8.
    time: { minutes: byte(0x41), seconds: byte(0x42) * 10 + byte(0x43) }, // $11A7/$0EE9.
    // $1196 copies tens to $05C8 and units to $05D2. $DFA0 borrows
    // between them when an untrained skill is consumed.
    skillStockBySlot: array(0x44, 8).map((tens, slot) => tens * 10 + byte(0x4c + slot)),
    skillStockDigits: array(0x44, 8).map((tens, slot) => ({ tens, units: byte(0x4c + slot) })),
    entrances: positions(0x6c, 3), // $1E44: spawned x = entrance.x + 2, y = entrance.y + 5.
    exits: positions(0x75, 2), // $1351 patches the exit tests at $1F80.
    objectTableEntries: byte(0x7b), // $2A54/$2B1C; this is not the map width.
    objectTablePointers: Array.from(
      { length: 10 },
      (_, index) => byte(0x80 + index * 2) | (byte(0x81 + index * 2) << 8),
    ),
    source: { headerAddress: 0xe000, nameAddress: 0xe019, positionByteOrder: 'big-endian' },
  };
}

/** Read the mutable terrain using the game's lookup tables, rather than
 * inventing a tile format. Raised from $287E/$28EC–$2924. One two-bit sample
 * occupies two physical horizontal VIC pixels. The ordinary probe tests a
 * nonzero pair; $2910 additionally treats pair 3 as empty for its callers.
 * Those are two distinct original probes, not a universal collision rule.
 * The reviewed domain excludes the clamped top/bottom border rows. */
export function sampleTerrain(memory: RecoveredMemory, x: number, y: number) {
  if (!Number.isInteger(x) || x < 0 || x >= 320 || !Number.isInteger(y) || y < 16 || y > 168) {
    throw new Error('Reviewed terrain coordinates are x=0–319, y=16–168.');
  }
  const adjustment = read(memory, 0x4a00 + x);
  const signedAdjustment = adjustment < 128 ? adjustment : adjustment - 256;
  const row = y + signedAdjustment;
  const low = read(memory, 0x4c00 + x) + read(memory, 0x4800 + row);
  const high = read(memory, 0x4e00 + x) + read(memory, 0x4900 + row) + (low >>> 8);
  const address = ((high << 8) | (low & 255)) & 65535;
  const shift = 6 - (x & 3) * 2;
  const pair = (read(memory, address) >>> shift) & 3;
  return {
    address,
    mask: 3 << shift,
    pair,
    ordinaryProbe: pair !== 0,
    probeIgnoringThree: pair !== 0 && pair !== 3,
  };
}

/** Diagnostic atlas of actual terrain pairs, using preview colours. Objects,
 * sprites, scrolling and the C64 toolbar belong to the separate VIC capture. */
export function decodeTerrain(memory: RecoveredMemory) {
  const width = 320,
    height = 153,
    originY = 16;
  const pairs = new Uint8Array(width * height);
  const collision = new Uint8Array(pairs.length);
  const pixels = new Uint8Array(width * 2 * height * 4);
  const palette = [0x000000, 0x6f4f25, 0x588d43, 0x9ad284];
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const sample = sampleTerrain(memory, x, row + originY);
      pairs[row * width + x] = sample.pair;
      collision[row * width + x] = sample.ordinaryProbe ? 1 : 0;
      const rgb = palette[sample.pair]!;
      for (let repeat = 0; repeat < 2; repeat++) {
        pixels.set(
          [rgb >>> 16, (rgb >>> 8) & 255, rgb & 255, 255],
          (row * width * 2 + x * 2 + repeat) * 4,
        );
      }
    }
  }
  return { width, height, originY, pairs, collision, pixels };
}
