import { PreparedRdpCombiner } from './rdp-combiner.js';
import { decodeRdpDepth, encodeRdpDepth, rdpPerspectiveCoordinate } from './rdp-pixels.js';
import type { N64PixelPipeline, RdpPixelState } from './rdp-pixels.js';
import type { RdpSpan } from './rdp-triangle.js';
import type { N64Texture } from './texture.js';

const clamp = (value: number) => Math.max(0, Math.min(255, Math.floor(value)));

/** A synchronous draw's immutable register decode and reusable registers.
 * Framebuffer/depth reads stay ordered per pixel; no deferred RDRAM writes.
 * Scalar N64PixelPipeline.write is the independently exercised reference. */
export class PreparedRdpPixels {
  private readonly combine: PreparedRdpCombiner;
  private readonly sample: (s: number, t: number) => number;
  private readonly blend = new Float64Array(16);
  private readonly bytes: number;
  private readonly high: number;
  private readonly low: number;
  private readonly image: RdpPixelState['colorImage'];
  private readonly depthImage: number;
  private readonly primitiveDepth: number;
  private readonly primitiveDz: number;
  private readonly p: number;
  private readonly a: number;
  private readonly m: number;
  private readonly b: number;

  constructor(
    private readonly pipeline: N64PixelPipeline,
    private readonly ram: DataView,
    texture: N64Texture,
    words: Uint32Array,
    state: RdpPixelState,
    tile: number,
    private readonly copy: boolean,
    private readonly unsupported: (kind: string, detail: string) => never,
  ) {
    this.high = state.modeHigh;
    this.low = state.modeLow;
    this.image = { ...state.colorImage };
    this.bytes = this.image.size === 2 ? 2 : 4;
    const cycle = (this.high >>> 20) & 3,
      low = this.low;
    this.combine = new PreparedRdpCombiner(words, cycle, unsupported);
    this.sample = texture.prepare(tile, !!(this.high & 0x2000 && this.high & 0xc00 && !copy));
    this.depthImage = words[125]! & 0x3ffffff;
    this.primitiveDepth = (words[93]! >>> 16) & 32767;
    this.primitiveDz = words[93]! & 65535;
    this.p = ((low >>> (cycle === 1 ? 28 : 30)) & 3) * 4;
    this.a = (low >>> (cycle === 1 ? 24 : 26)) & 3;
    this.m = ((low >>> (cycle === 1 ? 20 : 22)) & 3) * 4;
    this.b = (low >>> (cycle === 1 ? 16 : 18)) & 3;
    for (let c = 0; c < 4; c++) {
      this.blend[8 + c] = (words[115]! >>> (24 - c * 8)) & 255;
      this.blend[12 + c] = (words[113]! >>> (24 - c * 8)) & 255;
    }
  }

  write(span: RdpSpan): void {
    const source = this.copy ? 4 : this.combine.directRgb,
      low = this.low,
      image = this.image,
      destination = (low >>> 8) & 3,
      rowAddress = image.address + span.y * image.width * 2;
    // Complete coverage, no alpha-dependent coverage/threshold, no memory
    // coverage feedback. Copy cycle ignores depth/blending just as the scalar
    // pipeline does. Invalid ranges retain ordered per-pixel failure behavior.
    if (
      source &&
      (source === 4 || !span.textured) &&
      this.bytes === 2 &&
      image.format === 0 &&
      (low & 0x1001) === 0 &&
      (this.copy || (low & 0x4030) === 0) &&
      (destination === 0 || destination === 2) &&
      rowAddress + span.left * 2 >= 0 &&
      rowAddress + span.right * 2 <= this.ram.byteLength &&
      (rowAddress & 1) === 0
    ) {
      this.writeOpaque(span, rowAddress, source);
    } else {
      this.writeGeneral(span, span.left, span.right);
    }
  }

  private writeOpaque(span: RdpSpan, rowAddress: number, source: 4 | 12): void {
    const values = span.values,
      high = this.high,
      ram = this.ram,
      pipeline = this.pipeline;
    for (let x = span.left; x < span.right; x++) {
      const coverage = span.coverage[x]!;
      if (!coverage) {
        continue;
      }
      if (coverage !== 8) {
        this.writeGeneral(span, x, x + 1);
        continue;
      }
      const offset = x * 8;
      let packed: number;
      if (source === 4) {
        let texel = 0;
        if (span.textured) {
          let s = values[offset + 4]!,
            t = values[offset + 5]!;
          if (high & 0x80000) {
            const w = values[offset + 6]!;
            s = rdpPerspectiveCoordinate(s, w);
            t = rdpPerspectiveCoordinate(t, w);
          }
          texel = this.sample(Math.floor(s), Math.floor(t));
        }
        packed =
          ((texel >>> 27) << 11) | (((texel >>> 19) & 31) << 6) | (((texel >>> 11) & 31) << 1) | 1;
      } else {
        // Quantize once to the destination's five-bit RGB fields.
        const r = Math.max(0, Math.min(31, Math.floor(values[offset]! / 8))),
          g = Math.max(0, Math.min(31, Math.floor(values[offset + 1]! / 8))),
          b = Math.max(0, Math.min(31, Math.floor(values[offset + 2]! / 8)));
        packed = (r << 11) | (g << 6) | (b << 1) | 1;
      }
      const address = rowAddress + x * 2;
      ram.setUint16(address, packed, false);
      pipeline.hidden[address >>> 1] = 3;
      pipeline.written++;
    }
  }

  private writeGeneral(span: RdpSpan, left: number, right: number): void {
    const image = this.image,
      low = this.low,
      high = this.high,
      bytes = this.bytes,
      ram = this.ram,
      pipeline = this.pipeline,
      hidden = pipeline.hidden,
      values = span.values,
      sources = this.combine.sources,
      out = this.combine.output,
      blend = this.blend,
      rowAddress = image.address + span.y * image.width * bytes,
      depthRow = this.depthImage + span.y * image.width * 2,
      depthEnabled = !this.copy && (low & 0x30) !== 0,
      primitive = (low & 4) !== 0,
      dz = depthEnabled ? Math.max(1, Math.ceil(primitive ? this.primitiveDz : span.dz * 8)) : 1,
      depthMode = (low >>> 10) & 3,
      force = (low & 0x4000) !== 0,
      destination = (low >>> 8) & 3;
    for (let x = left; x < right; x++) {
      let coverage = span.coverage[x]!;
      if (!coverage) {
        continue;
      }
      if (image.format !== 0 || image.size < 2) {
        this.unsupported('rdp-color-format', 'Drawing currently requires RGBA16 or RGBA32 output.');
      }
      const address = rowAddress + x * bytes,
        offset = x * 8;
      if (address < 0 || address + bytes > ram.byteLength || address % bytes) {
        this.unsupported('rdp-framebuffer', 'A drawn pixel exceeds or misaligns its color image.');
      }
      let texel = 0;
      if (span.textured) {
        let s = values[offset + 4]!,
          t = values[offset + 5]!;
        if (high & 0x80000) {
          const w = values[offset + 6]!;
          s = rdpPerspectiveCoordinate(s, w);
          t = rdpPerspectiveCoordinate(t, w);
        }
        texel = this.sample(Math.floor(s), Math.floor(t));
      }
      if (this.copy) {
        out[0] = texel >>> 24;
        out[1] = (texel >>> 16) & 255;
        out[2] = (texel >>> 8) & 255;
        out[3] = texel & 255;
      } else if (this.combine.directRgb) {
        if (this.combine.directRgb === 4) {
          out[0] = texel >>> 24;
          out[1] = (texel >>> 16) & 255;
          out[2] = (texel >>> 8) & 255;
        } else {
          out[0] = clamp(values[offset]!);
          out[1] = clamp(values[offset + 1]!);
          out[2] = clamp(values[offset + 2]!);
        }
        out[3] = this.combine.evaluateDirectAlpha(texel & 255, clamp(values[offset + 3]!));
      } else {
        for (let c = 0; c < 4; c++) {
          sources[4 + c] = (texel >>> (24 - c * 8)) & 255;
          sources[12 + c] = clamp(values[offset + c]!);
        }
        this.combine.evaluate();
      }
      if (low & 1 && out[3]! < blend[11]!) {
        continue;
      }
      let depthAddress = 0,
        z = 0,
        oldZ = 0x3ffff;
      if (depthEnabled) {
        depthAddress = depthRow + x * 2;
        if (depthAddress + 2 > ram.byteLength || depthAddress & 1) {
          this.unsupported('rdp-depth-range', 'The depth image exceeds installed RDRAM.');
        }
        if (!primitive && !span.depth) {
          this.unsupported(
            'rdp-depth',
            'Depth enabled without triangle coefficients or a primitive depth.',
          );
        }
        const depth = primitive ? this.primitiveDepth : values[offset + 7]!;
        z = Math.max(0, Math.min(0x3ffff, Math.floor(depth * 8)));
        const packed = ram.getUint16(depthAddress, false);
        oldZ = decodeRdpDepth(packed);
        const tolerance = Math.max(dz, 2 ** Math.max(0, 6 - (packed >>> 13)));
        const pass =
          oldZ === 0x3ffff ||
          (depthMode === 3
            ? Math.abs(z - oldZ) <= tolerance
            : depthMode === 2
              ? z < oldZ
              : z <= oldZ + tolerance);
        if (low & 16 && !pass) {
          pipeline.rejectedDepth++;
          continue;
        }
      }
      const oldWord = bytes === 2 ? ram.getUint16(address, false) : ram.getUint32(address, false);
      if (low & 0x1000) {
        coverage = Math.min(8, Math.floor((coverage * out[3]!) / 255 + 0.5));
      }
      if (!coverage) {
        continue;
      }
      const memoryCoverage = bytes === 2 ? (((oldWord & 1) << 2) | hidden[address >>> 1]!) + 1 : 8,
        correlated = (low & 16) !== 0 && Math.abs(z - oldZ) <= dz && oldZ !== 0x3ffff;
      // Anti-aliased blending without FORCE_BL happens only when coverage does
      // not overflow and the new pixel is not clearly in front of memory, so
      // a surface's first edge write over the background stays unblended and
      // a second triangle sharing that edge blends the two surface colors.
      // Blending every partial pixel let the background bleed into interior
      // seams. Hardware reference: angrylion-rdp z_compare blend enable.
      const farther = (low & 16) === 0 || z + dz >= oldZ,
        overflow = ((coverage + memoryCoverage - 1) & 8) !== 0;
      if (!this.copy && (force || ((low & 8) !== 0 && !overflow && farther))) {
        blend[0] = out[0]!;
        blend[1] = out[1]!;
        blend[2] = out[2]!;
        blend[3] = out[3]!;
        if (bytes === 2) {
          blend[4] = ((oldWord >>> 11) * 255) / 31;
          blend[5] = (((oldWord >>> 6) & 31) * 255) / 31;
          blend[6] = (((oldWord >>> 1) & 31) * 255) / 31;
        } else {
          blend[4] = oldWord >>> 24;
          blend[5] = (oldWord >>> 16) & 255;
          blend[6] = (oldWord >>> 8) & 255;
        }
        let alpha =
          (this.a === 0 ? out[3]! : this.a === 1 ? blend[15]! : this.a === 2 ? sources[15]! : 0) /
          255;
        if (low & 0x2000) {
          alpha = coverage / 8;
        }
        let beta =
          this.b === 0
            ? 1 - alpha
            : this.b === 1
              ? correlated
                ? Math.max(0, 8 - coverage) / 8
                : 1 - alpha
              : this.b === 2
                ? 1
                : 0;
        if (!force && correlated) {
          alpha = coverage / Math.max(coverage + memoryCoverage, 8);
          beta = memoryCoverage / Math.max(coverage + memoryCoverage, 8);
        }
        const divisor = Math.max(alpha + beta, 1 / 256);
        for (let c = 0; c < 3; c++) {
          out[c] = clamp((blend[this.p + c]! * alpha + blend[this.m + c]! * beta) / divisor + 0.5);
        }
      }
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
        ram.setUint16(
          address,
          ((out[0]! >>> 3) << 11) |
            ((out[1]! >>> 3) << 6) |
            ((out[2]! >>> 3) << 1) |
            (((savedCoverage - 1) >>> 2) & 1),
          false,
        );
        hidden[address >>> 1] = (savedCoverage - 1) & 3;
      } else {
        ram.setUint32(
          address,
          ((out[0]! << 24) | (out[1]! << 16) | (out[2]! << 8) | out[3]!) >>> 0,
          false,
        );
      }
      if (!this.copy && low & 32) {
        const exponent = Math.min(15, Math.floor(Math.log2(dz)));
        ram.setUint16(depthAddress, encodeRdpDepth(z) | (exponent >>> 2), false);
        hidden[depthAddress >>> 1] = exponent & 3;
      }
      pipeline.written++;
    }
  }
}
