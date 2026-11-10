import { ExecutionGap } from '../../runtime/mos6502.js';

export interface VideoSnapshot {
  ram: Uint8Array;
  known: Uint8Array;
  colour: Uint8Array;
  registers: Uint8Array;
  bank: number;
}
export interface SpriteLine {
  index: number;
  data: readonly number[];
}
export interface CharacterLine {
  characters: Uint8Array;
  colours: Uint8Array;
  row: number;
  base: number;
  active: boolean;
}
export interface RenderRegion {
  start: number;
  end: number;
  pixels: Uint8Array;
  foreground: Uint8Array;
  spriteLines?: readonly SpriteLine[];
  characterLine?: CharacterLine;
}
// Preview colours, not a claim of analogue PAL colour or CRT reproduction.
const PALETTE = [
  0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f, 0x6f4f25,
  0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595,
];

/** Decode the C64's character/bitmap organisation into pixels. The same function
 * runs headlessly and in the browser; it contains no game logic. Without a
 * region this is a register snapshot. C64RasterDisplay supplies fetched sprite
 * rows and retained character codes/colours for a running raster capture. */
export function renderC64(video: VideoSnapshot, region?: RenderRegion): Uint8Array {
  const { ram, known, colour, registers: r, bank } = video;
  const pixels = region?.pixels ?? new Uint8Array(320 * 200 * 4);
  const foreground = region?.foreground ?? new Uint8Array(320 * 200);
  const start = region?.start ?? 0,
    end = region?.end ?? 200;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > 200 ||
    start > end ||
    pixels.length !== 320 * 200 * 4 ||
    foreground.length !== 320 * 200
  ) {
    throw new Error('Invalid VIC render region.');
  }
  const read = (address: number): number => {
    address &= 65535;
    if (!known[address]) {
      throw new ExecutionGap('video-memory', address, 'The display reads an unrecovered RAM byte.');
    }
    return ram[address]!;
  };
  const put = (x: number, y: number, ink: number): void => {
    const rgb = PALETTE[ink & 15]!,
      offset = (y * 320 + x) * 4;
    pixels[offset] = rgb >>> 16;
    pixels[offset + 1] = (rgb >>> 8) & 255;
    pixels[offset + 2] = rgb & 255;
    pixels[offset + 3] = 255;
  };
  const screenBase = bank + ((r[0x18]! & 0xf0) << 6);
  const charsetBase = bank + ((r[0x18]! & 14) << 10);
  const bitmapBase = bank + ((r[0x18]! & 8) << 10);
  const bitmap = !!(r[0x11]! & 32),
    extended = !!(r[0x11]! & 64),
    multicolour = !!(r[0x16]! & 16);
  // $D016 scrolls graphics to the right; sprites keep their independent VIC
  // coordinates. Ignoring this separated Nebulus's tunnels from Pogo by 4 px.
  const scrollX = r[0x16]! & 7;
  if (r[0x11]! & 16 && extended && (bitmap || multicolour)) {
    throw new ExecutionGap('video-mode', 0xd011, 'Illegal VIC display modes are not rendered.');
  }

  for (let y = start; y < end; y++) {
    for (let x = 0; x < 320; x++) {
      if (!(r[0x11]! & 16)) {
        foreground[y * 320 + x] = 0;
        put(x, y, r[0x20]!);
        continue;
      }
      const graphicsX = x - scrollX;
      if (graphicsX < 0) {
        foreground[y * 320 + x] = 0;
        put(x, y, r[0x21]!);
        continue;
      }
      const line = region?.characterLine;
      const column = graphicsX >>> 3;
      const cell = (line?.base ?? (y >>> 3) * 40) + column;
      const character = line ? line.characters[column]! : read(screenBase + cell);
      const cellColour = line ? line.colours[column]! : colour[cell]!;
      const row = line?.row ?? y & 7;
      let bits: number;
      if (line && !line.active) {
        bits = 0;
      } else if (bitmap) {
        bits = read(bitmapBase + cell * 8 + row);
      } else {
        const address = charsetBase + (extended ? character & 63 : character) * 8 + row;
        if (
          (bank === 0 || bank === 0x8000) &&
          (address & 0x3fff) >= 0x1000 &&
          (address & 0x3fff) < 0x2000
        ) {
          throw new ExecutionGap(
            'character-rom',
            address,
            'Character ROM is required for this display; no replacement font is substituted.',
          );
        }
        bits = read(address);
      }
      const widePixels = multicolour && (bitmap || !!(cellColour & 8));
      const pattern = widePixels
        ? (bits >>> (6 - (graphicsX & 6))) & 3
        : (bits >>> (7 - (graphicsX & 7))) & 1;
      let ink: number;
      if (widePixels) {
        const inks = bitmap
          ? [r[0x21]!, character >>> 4, character & 15, cellColour]
          : [r[0x21]!, r[0x22]!, r[0x23]!, cellColour & 7];
        ink = inks[pattern]!;
      } else {
        ink = pattern
          ? bitmap
            ? character >>> 4
            : cellColour
          : bitmap
            ? character & 15
            : r[0x21 + (extended ? character >>> 6 : 0)]!;
      }
      // In multicolour graphics, 01 is background for sprite priority. Only
      // 10/11 cover a sprite whose behind-background bit is set.
      foreground[y * 320 + x] = widePixels ? (pattern & 2 ? 1 : 0) : pattern ? 1 : 0;
      put(x, y, ink);
    }
  }

  // Lower sprite numbers win overlaps. Sprite/background collision latches and
  // multiplexing across raster lines are intentionally outside this snapshot.
  const spriteOccupied = new Uint8Array(320 * (end - start));
  for (let sprite = 0; sprite < 8; sprite++) {
    const mask = 1 << sprite;
    const latched = region?.spriteLines?.find((line) => line.index === sprite);
    if (region?.spriteLines ? !latched : !(r[0x15]! & mask)) {
      continue;
    }
    const originX = r[sprite * 2]! + (r[0x10]! & mask ? 256 : 0) - 24;
    const originY = r[sprite * 2 + 1]! - 50;
    const scaleX = r[0x1d]! & mask ? 2 : 1,
      scaleY = r[0x17]! & mask ? 2 : 1;
    const pointer = latched ? 0 : bank + read(screenBase + 0x3f8 + sprite) * 64;
    for (
      let py = latched ? 0 : Math.max(0, start - originY);
      py < (latched ? 1 : Math.min(21 * scaleY, end - originY));
      py++
    ) {
      for (let px = 0; px < 24 * scaleX; px++) {
        const x = originX + px,
          y = latched ? start : originY + py;
        if (x < 0 || x >= 320 || y < 0 || y >= 200) {
          continue;
        }
        const sx = Math.floor(px / scaleX),
          sy = Math.floor(py / scaleY);
        const bits = latched
          ? latched.data[Math.floor(sx / 8)]!
          : read(pointer + sy * 3 + Math.floor(sx / 8));
        const pattern =
          r[0x1c]! & mask ? (bits >>> (6 - (sx & 6))) & 3 : (bits >>> (7 - (sx & 7))) & 1;
        const occupied = (y - start) * 320 + x;
        if (!pattern || spriteOccupied[occupied]) {
          continue;
        }
        spriteOccupied[occupied] = 1;
        if (r[0x1b]! & mask && foreground[y * 320 + x]) {
          continue;
        }
        const ink =
          r[0x1c]! & mask
            ? [0, r[0x25]!, r[0x27 + sprite]!, r[0x26]!][pattern]!
            : r[0x27 + sprite]!;
        put(x, y, ink);
      }
    }
  }
  return pixels;
}
