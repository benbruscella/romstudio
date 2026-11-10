/** RDP texture descriptors and the processor's separate 4 KiB texture memory.
 * Image/descriptor coordinates are kept in their encoded fixed-point units. */
export interface N64Tile {
  format: number;
  size: number;
  line: number;
  tmem: number;
  palette: number;
  clampS: boolean;
  mirrorS: boolean;
  maskS: number;
  shiftS: number;
  clampT: boolean;
  mirrorT: boolean;
  maskT: number;
  shiftT: number;
  sl: number;
  tl: number;
  sh: number;
  th: number;
}

/** Encoded tile masks are powers of two. Wrapping an integer texel index
 * needs its low bits, including for negative coordinates; no division or
 * repeated floating-point remainder is needed. Nonfinite debugger inputs
 * retain the previous propagation through address calculation. */
function tileCoordinate(
  value: number,
  limit: number,
  mask: number,
  mirror: boolean,
  clamp: boolean,
) {
  if (clamp || mask === 0) {
    value = Math.max(0, Math.min(limit, value));
  }
  if (mask && Number.isFinite(value)) {
    const width = 1 << mask,
      period = mirror ? width * 2 : width;
    value &= period - 1;
    if (mirror && value >= width) {
      value = period - 1 - value;
    }
  }
  return value;
}

const rgba = (r: number, g: number, b: number, a: number) => (r << 24) | (g << 16) | (b << 8) | a;
const unpack = (color: number): [number, number, number, number] => [
  color >>> 24,
  (color >>> 16) & 255,
  (color >>> 8) & 255,
  color & 255,
];

export class N64Texture {
  readonly bytes = new Uint8Array(4096);
  readonly tiles: N64Tile[] = Array.from({ length: 8 }, () => ({
    format: 0,
    size: 0,
    line: 0,
    tmem: 0,
    palette: 0,
    clampS: false,
    mirrorS: false,
    maskS: 0,
    shiftS: 0,
    clampT: false,
    mirrorT: false,
    maskT: 0,
    shiftT: 0,
    sl: 0,
    tl: 0,
    sh: 0,
    th: 0,
  }));
  image = { format: 0, size: 0, width: 1, address: 0 };
  readonly loads: { tile: number; source: number; bytes: number; dxt: number }[] = [];

  constructor(private readonly unsupported: (kind: string, message: string) => never) {}

  setImage(high: number, low: number): void {
    this.image = {
      format: (high >>> 21) & 7,
      size: (high >>> 19) & 3,
      width: (high & 1023) + 1,
      address: low & 0x3ffffff,
    };
  }

  setTile(high: number, low: number): void {
    Object.assign(this.tiles[(low >>> 24) & 7]!, {
      format: (high >>> 21) & 7,
      size: (high >>> 19) & 3,
      line: (high >>> 9) & 511,
      tmem: high & 511,
      palette: (low >>> 20) & 15,
      clampT: (low & 0x80000) !== 0,
      mirrorT: (low & 0x40000) !== 0,
      maskT: (low >>> 14) & 15,
      shiftT: (low >>> 10) & 15,
      clampS: (low & 0x200) !== 0,
      mirrorS: (low & 0x100) !== 0,
      maskS: (low >>> 4) & 15,
      shiftS: low & 15,
    });
  }

  setSize(high: number, low: number): void {
    Object.assign(this.tiles[(low >>> 24) & 7]!, {
      sl: (high >>> 12) & 4095,
      tl: high & 4095,
      sh: (low >>> 12) & 4095,
      th: low & 4095,
    });
  }

  /** LoadBlock's S/H fields count texels, while DXT is unsigned 1.11. Each
   * transferred 64-bit word advances that counter; odd rows swap its two
   * 32-bit halves. Rendering uses a separate descriptor with a row stride. */
  loadBlock(high: number, low: number, ram: DataView): void {
    const index = (low >>> 24) & 7,
      tile = this.tiles[index]!;
    const sl = (high >>> 12) & 4095,
      tl = high & 4095,
      sh = (low >>> 12) & 4095,
      dxt = low & 4095;
    if (
      this.image.size < 1 ||
      this.image.size > 2 ||
      tile.size !== this.image.size ||
      this.image.format === 1
    ) {
      this.unsupported(
        'rdp-texture-load',
        'LoadBlock currently supports matching 8/16-bit image/load-tile sizes without YUV banking.',
      );
    }
    if (sh < sl) {
      this.unsupported('rdp-texture-load', 'LoadBlock has a reversed texel range.');
    }
    if (sl !== 0 || tl !== 0 || this.image.address % 8 !== 0) {
      this.unsupported(
        'rdp-texture-load',
        'LoadBlock currently requires a zero S/T origin and an eight-byte-aligned source image.',
      );
    }
    const texelBytes = this.image.size === 1 ? 1 : 2;
    const source = this.image.address + (tl * this.image.width + sl) * texelBytes;
    const count = Math.ceil(((sh - sl + 1) * texelBytes) / 8) * 8;
    if (source + count > ram.byteLength) {
      this.unsupported('rdp-texture-range', 'Texture load exceeds installed RDRAM.');
    }
    for (let word = 0; word < count / 8; word++) {
      const row = Math.floor((word * dxt) / 2048);
      const target = tile.tmem * 8 + word * 8 + row * tile.line * 8;
      for (let byte = 0; byte < 8; byte++) {
        this.bytes[((target + byte) ^ ((row & 1) * 4)) & 4095] = ram.getUint8(
          source + word * 8 + byte,
        );
      }
    }
    tile.sl = sl;
    tile.tl = tl;
    tile.sh = sh;
    tile.th = dxt;
    this.loads.push({ tile: index, source, bytes: count, dxt });
  }

  private coordinate(
    value: number,
    shift: number,
    low: number,
    high: number,
    mask: number,
    mirror: boolean,
    clamp: boolean,
  ): number {
    const shifted = shift <= 10 ? Math.floor(value / 2 ** shift) : value * 2 ** (16 - shift);
    return tileCoordinate(
      Math.floor((shifted - low * 8) / 32),
      Math.max(0, (high - low) >> 2),
      mask,
      mirror,
      clamp,
    );
  }

  /** The RDP's 2×2 filter interpolates three corners, choosing the triangle
   * on either side of the texel square's diagonal (not a four-tap average).
   * Sampling offsets are applied after the descriptor's coordinate shift. */
  sampleFiltered(index: number, s: number, t: number): [number, number, number, number] {
    const tile = this.tiles[index]!;
    const shifted = (value: number, shift: number) =>
      shift <= 10 ? Math.floor(value / 2 ** shift) : value * 2 ** (16 - shift);
    const ss = shifted(s, tile.shiftS) - tile.sl * 8,
      tt = shifted(t, tile.shiftT) - tile.tl * 8;
    const fx = ((ss % 32) + 32) % 32,
      fy = ((tt % 32) + 32) % 32;
    const x = Math.floor(ss / 32),
      y = Math.floor(tt / 32),
      limitS = Math.max(0, (tile.sh - tile.sl) >> 2),
      limitT = Math.max(0, (tile.th - tile.tl) >> 2),
      x0 = tileCoordinate(x, limitS, tile.maskS, tile.mirrorS, tile.clampS),
      x1 = tileCoordinate(x + 1, limitS, tile.maskS, tile.mirrorS, tile.clampS),
      y0 = tileCoordinate(y, limitT, tile.maskT, tile.mirrorT, tile.clampT),
      y1 = tileCoordinate(y + 1, limitT, tile.maskT, tile.mirrorT, tile.clampT);
    const lower = fx + fy < 32;
    const a = this.texel(tile, lower ? x0 : x1, lower ? y0 : y1),
      b = this.texel(tile, x1, y0),
      c = this.texel(tile, x0, y1),
      weightB = lower ? fx : 32 - fy,
      weightC = lower ? fy : 32 - fx,
      result: [number, number, number, number] = [0, 0, 0, 0];
    for (let component = 0; component < 4; component++) {
      const shift = 24 - component * 8,
        base = (a >>> shift) & 255;
      result[component] = Math.max(
        0,
        Math.min(
          255,
          Math.floor(
            base +
              ((((b >>> shift) & 255) - base) * weightB +
                (((c >>> shift) & 255) - base) * weightC +
                16) /
                32,
          ),
        ),
      );
    }
    return result;
  }

  /** Point sampling in signed S/T 10.5 units. Byte layout is independent of
   * host endianness; the same odd-row bank permutation applies on fetch. */
  sample(index: number, s: number, t: number): [number, number, number, number] {
    const tile = this.tiles[index]!;
    const x = this.coordinate(
      s,
      tile.shiftS,
      tile.sl,
      tile.sh,
      tile.maskS,
      tile.mirrorS,
      tile.clampS,
    );
    const y = this.coordinate(
      t,
      tile.shiftT,
      tile.tl,
      tile.th,
      tile.maskT,
      tile.mirrorT,
      tile.clampT,
    );
    return unpack(this.texel(tile, x, y));
  }

  /** Packed RGBA is local to sampling: three filter taps avoid allocating
   * three temporary color arrays. Public samples still return owned tuples. */
  private texel(tile: N64Tile, x: number, y: number): number {
    const bits = 4 * 2 ** tile.size;
    const address = ((tile.tmem + y * tile.line) * 8 + Math.floor((x * bits) / 8)) ^ ((y & 1) * 4);
    const byte = this.bytes[address & 4095]!;
    const half = (byte << 8) | this.bytes[(address + 1) & 4095]!;
    if (tile.format === 0 && tile.size === 2) {
      const expand = (v: number) => (v << 3) | (v >>> 2);
      return rgba(
        expand(half >>> 11),
        expand((half >>> 6) & 31),
        expand((half >>> 1) & 31),
        (half & 1) * 255,
      );
    }
    if (tile.format === 3 && tile.size === 2) {
      return rgba(byte, byte, byte, half & 255);
    }
    if (tile.format === 3 && tile.size === 1) {
      const i = (byte >>> 4) * 17;
      return rgba(i, i, i, (byte & 15) * 17);
    }
    const nibble = x & 1 ? byte & 15 : byte >>> 4;
    if (tile.format === 3 && tile.size === 0) {
      const i = nibble >>> 1,
        intensity = (i << 5) | (i << 2) | (i >>> 1);
      return rgba(intensity, intensity, intensity, (nibble & 1) * 255);
    }
    if (tile.format === 4 && tile.size <= 1) {
      const i = tile.size ? byte : nibble * 17;
      return rgba(i, i, i, i);
    }
    return this.unsupported(
      'rdp-texture-format',
      `Texture format ${tile.format}, size ${tile.size} is not implemented.`,
    );
  }

  /** Command-local packed sampler. Descriptors cannot change during a
   * synchronous draw; TMEM bytes are still read on every fetch. Choosing the
   * format and powers of two here removes that decoding from every tap.
   * The tuple APIs above remain the scalar reference and own their outputs. */
  prepare(index: number, filtered: boolean): (s: number, t: number) => number {
    const tile = { ...this.tiles[index]! },
      bytes = this.bytes,
      bits = 4 * 2 ** tile.size,
      limitS = Math.max(0, (tile.sh - tile.sl) >> 2),
      limitT = Math.max(0, (tile.th - tile.tl) >> 2),
      scaleS = 2 ** (tile.shiftS <= 10 ? -tile.shiftS : 16 - tile.shiftS),
      scaleT = 2 ** (tile.shiftT <= 10 ? -tile.shiftT : 16 - tile.shiftT);
    const address = (x: number, y: number) =>
      ((tile.tmem + y * tile.line) * 8 + Math.floor((x * bits) / 8)) ^ ((y & 1) * 4);
    let fetch: (x: number, y: number) => number;
    if (tile.format === 0 && tile.size === 2) {
      fetch = (x, y) => {
        const a = address(x, y),
          half = (bytes[a & 4095]! << 8) | bytes[(a + 1) & 4095]!,
          r = half >>> 11,
          g = (half >>> 6) & 31,
          b = (half >>> 1) & 31;
        return rgba(
          (r << 3) | (r >>> 2),
          (g << 3) | (g >>> 2),
          (b << 3) | (b >>> 2),
          (half & 1) * 255,
        );
      };
    } else if (tile.format === 3 && tile.size === 2) {
      fetch = (x, y) => {
        const a = address(x, y),
          i = bytes[a & 4095]!;
        return rgba(i, i, i, bytes[(a + 1) & 4095]!);
      };
    } else if (tile.format === 3 && tile.size === 1) {
      fetch = (x, y) => {
        const byte = bytes[address(x, y) & 4095]!,
          i = (byte >>> 4) * 17;
        return rgba(i, i, i, (byte & 15) * 17);
      };
    } else if (tile.format === 3 && tile.size === 0) {
      fetch = (x, y) => {
        const byte = bytes[address(x, y) & 4095]!,
          n = x & 1 ? byte & 15 : byte >>> 4,
          i = n >>> 1,
          intensity = (i << 5) | (i << 2) | (i >>> 1);
        return rgba(intensity, intensity, intensity, (n & 1) * 255);
      };
    } else if (tile.format === 4 && tile.size <= 1) {
      fetch = (x, y) => {
        const byte = bytes[address(x, y) & 4095]!,
          i = tile.size ? byte : (x & 1 ? byte & 15 : byte >>> 4) * 17;
        return rgba(i, i, i, i);
      };
    } else {
      fetch = () =>
        this.unsupported(
          'rdp-texture-format',
          `Texture format ${tile.format}, size ${tile.size} is not implemented.`,
        );
    }
    if (!filtered) {
      return (s, t) => {
        const ss = tile.shiftS <= 10 ? Math.floor(s * scaleS) : s * scaleS,
          tt = tile.shiftT <= 10 ? Math.floor(t * scaleT) : t * scaleT;
        return fetch(
          tileCoordinate(
            Math.floor((ss - tile.sl * 8) / 32),
            limitS,
            tile.maskS,
            tile.mirrorS,
            tile.clampS,
          ),
          tileCoordinate(
            Math.floor((tt - tile.tl * 8) / 32),
            limitT,
            tile.maskT,
            tile.mirrorT,
            tile.clampT,
          ),
        );
      };
    }
    return (s, t) => {
      const ss = (tile.shiftS <= 10 ? Math.floor(s * scaleS) : s * scaleS) - tile.sl * 8,
        tt = (tile.shiftT <= 10 ? Math.floor(t * scaleT) : t * scaleT) - tile.tl * 8,
        fx = ((ss % 32) + 32) % 32,
        fy = ((tt % 32) + 32) % 32,
        x = Math.floor(ss / 32),
        y = Math.floor(tt / 32),
        x0 = tileCoordinate(x, limitS, tile.maskS, tile.mirrorS, tile.clampS),
        x1 = tileCoordinate(x + 1, limitS, tile.maskS, tile.mirrorS, tile.clampS),
        y0 = tileCoordinate(y, limitT, tile.maskT, tile.mirrorT, tile.clampT),
        y1 = tileCoordinate(y + 1, limitT, tile.maskT, tile.mirrorT, tile.clampT),
        lower = fx + fy < 32,
        a = fetch(lower ? x0 : x1, lower ? y0 : y1),
        b = fetch(x1, y0),
        c = fetch(x0, y1),
        wb = lower ? fx : 32 - fy,
        wc = lower ? fy : 32 - fx;
      let packed = 0;
      for (let shift = 24; shift >= 0; shift -= 8) {
        const base = (a >>> shift) & 255;
        const value = Math.max(
          0,
          Math.min(
            255,
            Math.floor(
              base +
                ((((b >>> shift) & 255) - base) * wb + (((c >>> shift) & 255) - base) * wc + 16) /
                  32,
            ),
          ),
        );
        packed |= value << shift;
      }
      return packed;
    };
  }

  snapshot() {
    return {
      bytes: [...this.bytes],
      tiles: this.tiles.map((tile) => ({ ...tile })),
      image: { ...this.image },
      loads: this.loads.map((load) => ({ ...load })),
    };
  }

  restore(state: ReturnType<N64Texture['snapshot']>): void {
    this.bytes.set(state.bytes);
    state.tiles.forEach((tile, index) => Object.assign(this.tiles[index]!, tile));
    this.image = { ...state.image };
    this.loads.length = 0;
    for (const load of state.loads) {
      this.loads.push({ ...load });
    }
  }
}
