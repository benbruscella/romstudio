import type { N64Texture } from './texture.js';
import type { RdpFragment } from './rdp-triangle.js';
import { PreparedRdpPixels } from './rdp-span-pixels.js';

export type RdpColor = [number, number, number, number];
const clamp = (value: number) => Math.max(0, Math.min(255, Math.floor(value)));
const unpack = (word: number): RdpColor => [
  word >>> 24,
  (word >>> 16) & 255,
  (word >>> 8) & 255,
  word & 255,
];
const zBases = [0, 0x20000, 0x30000, 0x38000, 0x3c000, 0x3e000, 0x3f000, 0x3f800];
const zShifts = [6, 5, 4, 3, 2, 1, 0, 0];

/** Functional divide with the hardware's nonpositive-W overflow outcome.
 * Finite division still uses an ideal quotient rather than the RDP's LUT.
 * Hardware evidence: carmiker/n64docs, diagnostic cartridge section 2.3b. */
export function rdpPerspectiveCoordinate(coordinate: number, w: number): number {
  return w <= 0 ? 32767 : Math.max(-32768, Math.min(32767, Math.floor((coordinate * 32768) / w)));
}

/** Nintendo's 18-bit linear Z to 14-bit exponent/mantissa storage format.
 * The low two visible bits and two hidden RDRAM bits store log2(delta Z). */
export function decodeRdpDepth(packed: number): number {
  const exponent = packed >>> 13;
  return zBases[exponent]! + ((packed >>> 2) & 2047) * 2 ** zShifts[exponent]!;
}
export function encodeRdpDepth(z: number): number {
  z = Math.max(0, Math.min(0x3ffff, Math.floor(z)));
  let exponent = 0;
  while (exponent < 7 && z >= zBases[exponent + 1]!) {
    exponent++;
  }
  return ((exponent << 11) | Math.floor((z - zBases[exponent]!) / 2 ** zShifts[exponent]!)) << 2;
}

export interface RdpPixelState {
  modeHigh: number;
  modeLow: number;
  colorImage: { format: number; size: number; width: number; address: number };
}

/** Functional pixel pipeline. Geometry arrives from original microcode;
 * this layer interprets RDP muxes, texture sampling, depth and framebuffer
 * writes. Coverage/blend rounding and perspective divide are approximations,
 * explicitly separate from independent hardware parity. */
export class N64PixelPipeline {
  readonly hidden: Uint8Array;
  written = 0;
  rejectedDepth = 0;
  private readonly colorWords = new Uint32Array(4);
  private readonly colorCache: RdpColor[] = [];
  constructor(
    private readonly ram: DataView,
    private readonly texture: N64Texture,
    private readonly stateWords: Uint32Array,
    private readonly unsupported: (kind: string, detail: string) => never,
  ) {
    this.hidden = new Uint8Array(ram.byteLength >>> 1);
  }

  fillHidden(address: number, size: number, value: number): void {
    this.hidden[address >>> 1] = value & 1 ? 3 : 0;
    if (size === 4) {
      this.hidden[(address >>> 1) + 1] = value & 1 ? 3 : 0;
    }
  }

  private color(register: number): RdpColor {
    const index = register - 0x38,
      word = this.stateWords[register * 2 + 1]!;
    let color = this.colorCache[index];
    if (!color || this.colorWords[index] !== word) {
      this.colorWords[index] = word;
      this.colorCache[index] = color = unpack(word);
    }
    return color;
  }

  /** Decode command-constant state once. The owned-fragment write/combine
   * methods below remain the scalar reference used by debugger fixtures. */
  prepare(state: RdpPixelState, tile: number, copy = false): PreparedRdpPixels {
    return new PreparedRdpPixels(
      this,
      this.ram,
      this.texture,
      this.stateWords,
      state,
      tile,
      copy,
      this.unsupported,
    );
  }

  combine(texel: RdpColor, shade: RdpColor, cycleType: number): RdpColor {
    const high = this.stateWords[0x3c * 2]!,
      low = this.stateWords[0x3c * 2 + 1]!;
    const primitive = this.color(0x3a),
      environment = this.color(0x3b);
    let combined: RdpColor = [0, 0, 0, 0];
    const rgba = (selector: number, component: number): number => {
      if (selector === 0) {
        return combined[component]!;
      }
      if (selector === 1) {
        return texel[component]!;
      }
      if (selector === 2) {
        return this.unsupported('rdp-combiner', 'A second texture/LOD sample is not implemented.');
      }
      if (selector === 3) {
        return primitive[component]!;
      }
      if (selector === 4) {
        return shade[component]!;
      }
      return environment[component]!;
    };
    for (let cycle = cycleType === 1 ? 0 : 1; cycle <= 1; cycle++) {
      const a = cycle === 0 ? (high >>> 20) & 15 : (high >>> 5) & 15;
      const b = cycle === 0 ? (low >>> 28) & 15 : (low >>> 24) & 15;
      const c = cycle === 0 ? (high >>> 15) & 31 : high & 31;
      const d = cycle === 0 ? (low >>> 15) & 7 : (low >>> 6) & 7;
      const aa = cycle === 0 ? (high >>> 12) & 7 : (low >>> 21) & 7;
      const ab = cycle === 0 ? (low >>> 12) & 7 : (low >>> 3) & 7;
      const ac = cycle === 0 ? (high >>> 9) & 7 : (low >>> 18) & 7;
      const ad = cycle === 0 ? (low >>> 9) & 7 : low & 7;
      const rgbInput = (
        selector: number,
        slot: 'a' | 'b' | 'c' | 'd',
        component: number,
      ): number => {
        if (selector < 6) {
          return rgba(selector, component);
        }
        if (slot === 'd') {
          return selector === 6 ? 256 : 0;
        }
        if (slot === 'c') {
          if (selector >= 7 && selector <= 12) {
            return rgba(selector - 7, 3);
          }
          if (selector === 14) {
            return this.stateWords[0x3a * 2]! & 255;
          }
          if (selector >= 16) {
            return 0;
          }
        } else {
          if (selector >= 8) {
            return 0;
          }
          if (slot === 'a' && selector === 6) {
            return 256;
          }
        }
        return this.unsupported(
          'rdp-combiner',
          `RGB ${slot} input ${selector} (key/noise/conversion/LOD) is not implemented.`,
        );
      };
      const alphaInput = (selector: number, multiply = false): number => {
        if (multiply && selector === 0) {
          return this.unsupported('rdp-combiner', 'Texture LOD alpha is not implemented.');
        }
        if (selector < 6) {
          return rgba(selector, 3);
        }
        return selector === 7 ? 0 : multiply ? this.stateWords[0x3a * 2]! & 255 : 256;
      };
      const output: RdpColor = [0, 0, 0, 0];
      for (let component = 0; component < 3; component++) {
        const add = rgbInput(d, 'd', component);
        output[component] =
          a === b || c >= 16
            ? clamp(add)
            : clamp(
                ((rgbInput(a, 'a', component) - rgbInput(b, 'b', component)) *
                  rgbInput(c, 'c', component)) /
                  256 +
                  add +
                  0.5,
              );
      }
      output[3] =
        aa === ab || ac === 7
          ? clamp(alphaInput(ad))
          : clamp(
              ((alphaInput(aa) - alphaInput(ab)) * alphaInput(ac, true)) / 256 +
                alphaInput(ad) +
                0.5,
            );
      combined = output;
    }
    return combined;
  }

  write(state: RdpPixelState, fragment: RdpFragment, tile: number, copy = false): boolean {
    const image = state.colorImage,
      high = state.modeHigh,
      low = state.modeLow;
    if (image.format !== 0 || image.size < 2) {
      return this.unsupported(
        'rdp-color-format',
        'Drawing currently requires RGBA16 or RGBA32 output.',
      );
    }
    const bytes = image.size === 2 ? 2 : 4,
      address = image.address + (fragment.y * image.width + fragment.x) * bytes;
    if (address < 0 || address + bytes > this.ram.byteLength || address % bytes) {
      return this.unsupported(
        'rdp-framebuffer',
        'A drawn pixel exceeds or misaligns its color image.',
      );
    }
    let texel: RdpColor = [0, 0, 0, 0];
    if (fragment.texture) {
      let [s, t] = fragment.texture;
      const w = fragment.texture[2]!;
      if (high & 0x80000) {
        s = rdpPerspectiveCoordinate(s!, w);
        t = rdpPerspectiveCoordinate(t!, w);
      }
      texel =
        high & 0x2000 && high & 0xc00 && !copy
          ? this.texture.sampleFiltered(tile, Math.floor(s!), Math.floor(t!))
          : this.texture.sample(tile, Math.floor(s!), Math.floor(t!));
    }
    const shade = fragment.shade.map(clamp) as RdpColor;
    let color = copy ? texel : this.combine(texel, shade, (high >>> 20) & 3);
    if (low & 1 && color[3] < this.color(0x39)[3]) {
      return false;
    }
    let depthAddress = 0,
      z = 0,
      oldZ = 0x3ffff,
      dz = 1;
    if (!copy && low & 0x30) {
      depthAddress =
        (this.stateWords[0x3e * 2 + 1]! & 0x3ffffff) + (fragment.y * image.width + fragment.x) * 2;
      if (depthAddress + 2 > this.ram.byteLength || depthAddress & 1) {
        return this.unsupported('rdp-depth-range', 'The depth image exceeds installed RDRAM.');
      }
      const depth = low & 4 ? (this.stateWords[0x2e * 2 + 1]! >>> 16) & 32767 : fragment.depth;
      if (depth === undefined) {
        return this.unsupported(
          'rdp-depth',
          'Depth enabled without triangle coefficients or a primitive depth.',
        );
      }
      z = Math.max(0, Math.min(0x3ffff, Math.floor(depth * 8)));
      dz = Math.max(
        1,
        Math.ceil(low & 4 ? this.stateWords[0x2e * 2 + 1]! & 65535 : fragment.dz * 8),
      );
      oldZ = decodeRdpDepth(this.ram.getUint16(depthAddress, false));
      const mode = (low >>> 10) & 3;
      const tolerance = Math.max(
        dz,
        2 ** Math.max(0, 6 - (this.ram.getUint16(depthAddress, false) >>> 13)),
      );
      const pass =
        oldZ === 0x3ffff ||
        (mode === 3
          ? Math.abs(z - oldZ) <= tolerance
          : mode === 2
            ? z < oldZ
            : z <= oldZ + tolerance);
      if (low & 16 && !pass) {
        this.rejectedDepth++;
        return false;
      }
    }
    const oldWord =
      bytes === 2 ? this.ram.getUint16(address, false) : this.ram.getUint32(address, false);
    const oldColor: RdpColor =
      bytes === 2
        ? [
            ((oldWord >>> 11) * 255) / 31,
            (((oldWord >>> 6) & 31) * 255) / 31,
            (((oldWord >>> 1) & 31) * 255) / 31,
            255,
          ]
        : unpack(oldWord);
    let coverage = fragment.coverage;
    if (low & 0x1000) {
      coverage = Math.min(8, Math.floor((coverage * color[3]) / 255 + 0.5));
    }
    if (coverage === 0) {
      return false;
    }
    const memoryCoverage =
      bytes === 2 ? (((oldWord & 1) << 2) | this.hidden[address >>> 1]!) + 1 : 8;
    const correlated = (low & 16) !== 0 && Math.abs(z - oldZ) <= dz && oldZ !== 0x3ffff;
    const force = (low & 0x4000) !== 0;
    // Same anti-aliased blend enable as the span writer: no coverage
    // overflow, and the new pixel not clearly in front of memory.
    const farther = (low & 16) === 0 || z + dz >= oldZ,
      overflow = ((coverage + memoryCoverage - 1) & 8) !== 0;
    if (!copy && (force || ((low & 8) !== 0 && !overflow && farther))) {
      const cycle = ((high >>> 20) & 3) === 1 ? 1 : 0;
      const p = (low >>> (cycle ? 28 : 30)) & 3,
        a = (low >>> (cycle ? 24 : 26)) & 3,
        m = (low >>> (cycle ? 20 : 22)) & 3,
        b = (low >>> (cycle ? 16 : 18)) & 3;
      const sources = [color, oldColor, this.color(0x39), this.color(0x38)];
      let alpha = [color[3], this.color(0x38)[3], shade[3], 0][a]! / 255;
      if (low & 0x2000) {
        alpha = coverage / 8;
      }
      let beta =
        b === 0
          ? 1 - alpha
          : b === 1
            ? correlated
              ? Math.max(0, 8 - coverage) / 8
              : 1 - alpha
            : b === 2
              ? 1
              : 0;
      if (!force && correlated) {
        alpha = coverage / Math.max(coverage + memoryCoverage, 8);
        beta = memoryCoverage / Math.max(coverage + memoryCoverage, 8);
      }
      const divisor = Math.max(alpha + beta, 1 / 256);
      color = color.map((value, i) =>
        i === 3 ? value : clamp((sources[p]![i]! * alpha + sources[m]![i]! * beta) / divisor + 0.5),
      ) as RdpColor;
    }
    const destination = (low >>> 8) & 3;
    const savedCoverage =
      destination === 3
        ? memoryCoverage
        : destination === 2
          ? 8
          : destination === 1
            ? ((coverage + memoryCoverage - 1) & 7) + 1
            : correlated
              ? Math.min(8, coverage + memoryCoverage)
              : coverage;
    if (bytes === 2) {
      const packed =
        ((color[0] >>> 3) << 11) |
        ((color[1] >>> 3) << 6) |
        ((color[2] >>> 3) << 1) |
        (((savedCoverage - 1) >>> 2) & 1);
      this.ram.setUint16(address, packed, false);
      this.hidden[address >>> 1] = (savedCoverage - 1) & 3;
    } else {
      this.ram.setUint32(
        address,
        ((color[0] << 24) | (color[1] << 16) | (color[2] << 8) | color[3]) >>> 0,
        false,
      );
    }
    if (!copy && low & 32) {
      const exponent = Math.min(15, Math.floor(Math.log2(dz)));
      this.ram.setUint16(depthAddress, encodeRdpDepth(z) | (exponent >>> 2), false);
      this.hidden[depthAddress >>> 1] = exponent & 3;
    }
    this.written++;
    return true;
  }

  snapshot() {
    let binary = '';
    for (let offset = 0; offset < this.hidden.length; offset += 16384) {
      binary += String.fromCharCode(...this.hidden.subarray(offset, offset + 16384));
    }
    return { hidden: btoa(binary), written: this.written, rejectedDepth: this.rejectedDepth };
  }
  restore(state: ReturnType<N64PixelPipeline['snapshot']>): void {
    const binary = atob(state.hidden);
    if (binary.length !== this.hidden.length) {
      throw new Error('RDP hidden-memory checkpoint has the wrong size.');
    }
    for (let i = 0; i < binary.length; i++) {
      this.hidden[i] = binary.charCodeAt(i);
    }
    this.written = state.written;
    this.rejectedDepth = state.rejectedDepth;
  }
}
