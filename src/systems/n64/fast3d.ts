import type { N64Display } from './display.js';
import type { RdpPlane, RdpTriangle } from './rdp-triangle.js';

/**
 * Play tier: a high-level implementation of the Fast3D graphics microcode.
 *
 * The reference tier runs the cartridge's original RSP instructions. This
 * file is ROM Studio's own TypeScript account of the documented Fast3D
 * display-list commands, used only by Play and only for the exact microcode
 * identified below. It transforms vertices, lights them, clips against the
 * near plane and sends triangles to the same software RDP. It encodes no game
 * rules. Any command it does not implement makes the whole task fall back to
 * the original microcode before any output is drawn.
 *
 * References: original command fields in n64decomp/sm64 include/PR/gbi.h;
 * SGI RDP Command Summary (triangle coefficients); SGI N64 programming
 * manual (matrices, lights, fog and texture generation).
 */

/** Fast3D "RSP SW Version: 2.0D, 04-01-96", identified by FNV-1a hashes of
 * the exact text (IMEM) and data (DMEM) images that a graphics task loads. */
export const fast3dMicrocode = {
  name: 'Fast3D 2.0D',
  textBytes: 0x1000,
  text: 0xe8812872,
  dataBytes: 0x800,
  data: 0xc5a5d5a5,
} as const;

export function fnv1a(bytes: Uint8Array, offset: number, length: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    hash ^= bytes[offset + i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

class Fast3dUnsupported extends Error {}

const geometryZBuffer = 0x1,
  geometryShade = 0x4,
  geometrySmooth = 0x200,
  geometryCullFront = 0x1000,
  geometryCullBack = 0x2000,
  geometryFog = 0x10000,
  geometryLighting = 0x20000,
  geometryTextureGen = 0x40000,
  geometryTextureGenLinear = 0x80000;

// Vertex attributes: clip-space position, then color and texture coordinates.
const X = 0,
  Y = 1,
  Z = 2,
  W = 3,
  R = 4,
  G = 5,
  B = 6,
  A = 7,
  S = 8,
  T = 9,
  attributes = 10;

// Projected polygon attributes for triangle setup.
const PX = 0,
  PY = 1,
  PZ = 2,
  PR = 3,
  PG = 4,
  PB = 5,
  PA = 6,
  PS = 7,
  PT = 8,
  PW = 9,
  projected = 10;

const displayListDepth = 10,
  matrixDepth = 10;

/** Where a completed task's RDP work goes: the same thread's display, or a
 * stream for a parallel RDP worker. `load` names the RDRAM bytes that the
 * following texture-load command reads, so a stream can carry a snapshot. */
export interface RdpSink {
  command(high: number, low: number, secondHigh: number, secondLow: number): void;
  triangle(triangle: RdpTriangle): void;
  load(address: number, bytes: number): void;
  finish(): void;
}

/** Draws synchronously on the display that shares the machine's RDRAM. */
export class DisplaySink implements RdpSink {
  constructor(private readonly display: N64Display) {}
  command(high: number, low: number, secondHigh: number, secondLow: number): void {
    this.display.submit(high, low, secondHigh, secondLow);
  }
  triangle(triangle: RdpTriangle): void {
    this.display.submitTriangle(triangle);
  }
  load(): void {}
  finish(): void {}
}

class TextureLoad {
  constructor(
    readonly address: number,
    readonly bytes: number,
  ) {}
}

type RdpOperation = RdpTriangle | TextureLoad | readonly number[];

const texelBits = [4, 8, 16, 32];

export class Fast3dTasks {
  /** Host observations; excluded from architectural checkpoints. */
  readonly stats = { tasks: 0, fallbacks: 0, triangles: 0, lastFallback: '' };
  private readonly view: DataView;
  private readonly segments = new Uint32Array(16);
  private readonly modelview = new Float64Array(16);
  private readonly stack = new Float64Array(16 * matrixDepth);
  private stackDepth = 0;
  private readonly projection = new Float64Array(16);
  private readonly combined = new Float64Array(16);
  private combinedDirty = true;
  private readonly loaded = new Float64Array(16);
  private readonly product = new Float64Array(16);
  private readonly viewportScale = new Float64Array(3);
  private readonly viewportTranslate = new Float64Array(3);
  private geometry = 0;
  private otherHigh = 0x080cff;
  private otherLow = 0;
  private textureOn = false;
  private textureTile = 0;
  private textureLevel = 0;
  private textureScaleS = 0;
  private textureScaleT = 0;
  private lightCount = 0;
  private readonly lightColor = new Float64Array(8 * 3);
  private readonly lightDirection = new Float64Array(8 * 3);
  private readonly lookAt = new Float64Array(6);
  private readonly modelLight = new Float64Array(8 * 3);
  private readonly modelLookAt = new Float64Array(6);
  private lightsDirty = true;
  private fogMultiplier = 0;
  private fogOffset = 0;
  private readonly vertices = new Float64Array(16 * attributes);
  private readonly polygon = new Float64Array(8 * attributes);
  private readonly clipped = new Float64Array(8 * attributes);
  private readonly screen = new Float64Array(8 * projected);
  /** The polygon buffer that holds the last clipping result. */
  private clippedSource = this.polygon;
  private readonly operations: RdpOperation[] = [];
  private imageSize = 0;
  private imageWidth = 1;
  private imageAddress = 0;

  constructor(
    private readonly ram: Uint8Array,
    private readonly sink: RdpSink,
  ) {
    this.view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  }

  /** True when the OSTask in DMEM is a fresh graphics task for the
   * recognized Fast3D text and data images. Resumed (yielded) tasks keep
   * their saved microcode state, so they stay on the original instructions. */
  recognizes(dmem: DataView): boolean {
    const type = dmem.getUint32(0xfc0, false),
      flags = dmem.getUint32(0xfc4, false),
      text = dmem.getUint32(0xfd0, false) & 0x1fffffff,
      textBytes = dmem.getUint32(0xfd4, false),
      data = dmem.getUint32(0xfd8, false) & 0x1fffffff,
      dataBytes = dmem.getUint32(0xfdc, false);
    if (type !== 1 || (flags & 1) !== 0) {
      return false;
    }
    if (textBytes !== fast3dMicrocode.textBytes || dataBytes !== fast3dMicrocode.dataBytes) {
      return false;
    }
    if (text + textBytes > this.ram.length || data + dataBytes > this.ram.length) {
      return false;
    }
    return (
      fnv1a(this.ram, text, textBytes) === fast3dMicrocode.text &&
      fnv1a(this.ram, data, dataBytes) === fast3dMicrocode.data
    );
  }

  /** Runs a whole recognized graphics task. Returns false, having drawn
   * nothing, when the task must run on the original microcode instead. */
  run(dmem: DataView): boolean {
    return this.recognizes(dmem) && this.runList(dmem.getUint32(0xff0, false) & 0xffffff);
  }

  /** Interprets one task's display list from its RDRAM address. Output
   * reaches the sink only when the whole list succeeds. */
  runList(start: number): boolean {
    this.reset();
    try {
      this.interpret(start);
    } catch (error) {
      this.operations.length = 0;
      if (error instanceof Fast3dUnsupported) {
        this.stats.fallbacks++;
        this.stats.lastFallback = error.message;
        return false;
      }
      throw error;
    }
    const sink = this.sink;
    for (const operation of this.operations) {
      if (operation instanceof TextureLoad) {
        sink.load(operation.address, operation.bytes);
      } else if ('opcode' in operation) {
        sink.triangle(operation);
      } else {
        sink.command(operation[0]!, operation[1]!, operation[2] ?? 0, operation[3] ?? 0);
      }
    }
    this.operations.length = 0;
    sink.finish();
    this.stats.tasks++;
    return true;
  }

  /** Each task reloads the microcode's DMEM image, so its state starts from
   * the data image defaults: other modes $EF080CFF/$00000000, empty segments. */
  private reset(): void {
    this.segments.fill(0);
    identity(this.modelview);
    identity(this.projection);
    this.stackDepth = 0;
    this.combinedDirty = true;
    this.viewportScale.fill(0);
    this.viewportTranslate.fill(0);
    this.geometry = 0;
    this.otherHigh = 0x080cff;
    this.otherLow = 0;
    this.textureOn = false;
    this.textureTile = 0;
    this.textureLevel = 0;
    this.textureScaleS = 0;
    this.textureScaleT = 0;
    this.lightCount = 0;
    this.lightColor.fill(0);
    this.lightDirection.fill(0);
    this.lookAt.fill(0);
    this.lightsDirty = true;
    this.fogMultiplier = 0;
    this.fogOffset = 0;
    this.vertices.fill(0);
  }

  private unsupported(detail: string): never {
    throw new Fast3dUnsupported(detail);
  }

  private address(segmented: number): number {
    return (this.segments[(segmented >>> 24) & 15]! + (segmented & 0xffffff)) & 0xffffff;
  }

  private checkRange(address: number, bytes: number): void {
    if (address + bytes > this.ram.length) {
      this.unsupported('A display-list address exceeds installed RDRAM.');
    }
  }

  private interpret(start: number): void {
    const view = this.view,
      returns = new Uint32Array(displayListDepth);
    let depth = 0,
      pc = start,
      budget = 4000000;
    for (;;) {
      if (--budget < 0) {
        this.unsupported('The display list did not end.');
      }
      this.checkRange(pc, 8);
      const w0 = view.getUint32(pc, false),
        w1 = view.getUint32(pc + 4, false),
        opcode = w0 >>> 24;
      pc += 8;
      switch (opcode) {
        case 0x00: // G_SPNOOP
          break;
        case 0x01: // G_MTX
          this.matrix(w0, w1);
          break;
        case 0x03: // G_MOVEMEM
          this.moveMemory(w0, w1);
          break;
        case 0x04: // G_VTX
          this.loadVertices(w0, w1);
          break;
        case 0x06: {
          // G_DL: push unless the branch flag is set.
          const target = this.address(w1);
          if (((w0 >>> 16) & 0xff) === 0) {
            if (depth >= displayListDepth) {
              this.unsupported('Display-list nesting exceeds the microcode stack.');
            }
            returns[depth++] = pc;
          }
          pc = target;
          break;
        }
        case 0xb3: // G_RDPHALF_2 and G_RDPHALF_1 carry texture-rectangle words.
        case 0xb4:
          break;
        case 0xb6: // G_CLEARGEOMETRYMODE
          this.geometry &= ~w1;
          break;
        case 0xb7: // G_SETGEOMETRYMODE
          this.geometry |= w1;
          break;
        case 0xb8: // G_ENDDL
          if (depth === 0) {
            return;
          }
          pc = returns[--depth]!;
          break;
        case 0xb9: // G_SETOTHERMODE_L
        case 0xba: // G_SETOTHERMODE_H
          this.otherMode(opcode, w0, w1);
          break;
        case 0xbb: // G_TEXTURE
          this.textureScaleS = (w1 >>> 16) / 65536;
          this.textureScaleT = (w1 & 0xffff) / 65536;
          this.textureLevel = (w0 >>> 11) & 7;
          this.textureTile = (w0 >>> 8) & 7;
          this.textureOn = (w0 & 0xff) !== 0;
          break;
        case 0xbc: // G_MOVEWORD
          this.moveWord(w0, w1);
          break;
        case 0xbd: // G_POPMTX (modelview)
          if (this.stackDepth > 0) {
            this.stackDepth--;
            this.modelview.set(
              this.stack.subarray(this.stackDepth * 16, this.stackDepth * 16 + 16),
            );
            this.combinedDirty = true;
            this.lightsDirty = true;
          }
          break;
        case 0xbe: // G_CULLDL
          if (this.culled((w0 & 0xffff) / 40, w1 / 40)) {
            if (depth === 0) {
              return;
            }
            pc = returns[--depth]!;
          }
          break;
        case 0xbf: // G_TRI1
          this.triangle(w1);
          break;
        case 0xe4: // G_TEXRECT and G_TEXRECTFLIP, followed by RDPHALF_1/2.
        case 0xe5: {
          this.checkRange(pc, 16);
          if (view.getUint8(pc) !== 0xb4 || view.getUint8(pc + 8) !== 0xb3) {
            this.unsupported('A texture rectangle lacks its RDPHALF words.');
          }
          this.operations.push([
            w0,
            w1,
            view.getUint32(pc + 4, false),
            view.getUint32(pc + 12, false),
          ]);
          pc += 16;
          break;
        }
        case 0xef: // RDP SetOtherMode updates the microcode's copy too.
          this.otherHigh = w0 & 0xffffff;
          this.otherLow = w1;
          this.operations.push([w0, w1]);
          break;
        case 0xfd: // SetTextureImage, SetDepthImage, SetColorImage use segments.
        case 0xfe:
        case 0xff: {
          const address = this.address(w1);
          if (opcode === 0xfd) {
            this.imageSize = (w0 >>> 19) & 3;
            this.imageWidth = (w0 & 1023) + 1;
            this.imageAddress = address;
          }
          this.operations.push([w0, address]);
          break;
        }
        case 0xf0: // LoadTLUT, LoadBlock and LoadTile read the texture image.
        case 0xf3:
        case 0xf4:
          this.textureLoad(opcode, w0, w1);
          this.operations.push([w0, w1]);
          break;
        default:
          if (opcode >= 0xe6) {
            this.operations.push([w0, w1]);
            break;
          }
          this.unsupported(`Fast3D command $${opcode.toString(16)} is not implemented.`);
      }
    }
  }

  /** Records the RDRAM range a texture load will read from the current
   * texture image, so a parallel RDP can receive a snapshot taken now. The
   * image state persists across tasks, as it does in the RDP. */
  private textureLoad(opcode: number, w0: number, w1: number): void {
    const bits = texelBits[this.imageSize]!,
      width = this.imageWidth;
    let first: number, bytes: number;
    if (opcode === 0xf3) {
      // LoadBlock: S/T origin and last texel are whole texels.
      const sl = (w0 >>> 12) & 4095,
        tl = w0 & 4095,
        sh = (w1 >>> 12) & 4095;
      first = Math.floor(((tl * width + sl) * bits) / 8);
      bytes = Math.max(0, Math.ceil(((sh - sl + 1) * bits) / 64) * 8);
    } else {
      // LoadTile and LoadTLUT use 10.2 coordinates; cover whole rows.
      const sl = ((w0 >>> 12) & 4095) >>> 2,
        tl = (w0 & 4095) >>> 2,
        sh = ((w1 >>> 12) & 4095) >>> 2,
        th = (w1 & 4095) >>> 2,
        rows = Math.max(1, th - tl + 1);
      first = Math.floor(((tl * width + sl) * bits) / 8);
      bytes =
        (rows - 1) * Math.ceil((width * bits) / 8) +
        Math.max(0, Math.ceil(((sh - sl + 1) * bits) / 8)) +
        8;
    }
    const address = this.imageAddress + first;
    if (address < this.ram.length && bytes > 0) {
      this.operations.push(new TextureLoad(address, Math.min(bytes, this.ram.length - address)));
    }
  }

  private matrix(w0: number, w1: number): void {
    const parameters = (w0 >>> 16) & 0xff,
      address = this.address(w1);
    this.checkRange(address, 64);
    const loaded = this.loaded;
    for (let i = 0; i < 16; i++) {
      loaded[i] =
        this.view.getInt16(address + i * 2, false) +
        this.view.getUint16(address + 32 + i * 2, false) / 65536;
    }
    // Row vectors: a new matrix applies before the current one.
    if (parameters & 1) {
      if (parameters & 2) {
        this.projection.set(loaded);
      } else {
        multiply(loaded, this.projection, this.product);
        this.projection.set(this.product);
      }
    } else {
      if (parameters & 4) {
        if (this.stackDepth >= matrixDepth) {
          this.unsupported('The modelview matrix stack overflowed.');
        }
        this.stack.set(this.modelview, this.stackDepth * 16);
        this.stackDepth++;
      }
      if (parameters & 2) {
        this.modelview.set(loaded);
      } else {
        multiply(loaded, this.modelview, this.product);
        this.modelview.set(this.product);
      }
      this.lightsDirty = true;
    }
    this.combinedDirty = true;
  }

  private moveMemory(w0: number, w1: number): void {
    const index = (w0 >>> 16) & 0xff,
      address = this.address(w1),
      view = this.view;
    this.checkRange(address, 16);
    if (index === 0x80) {
      for (let i = 0; i < 3; i++) {
        this.viewportScale[i] = view.getInt16(address + i * 2, false);
        this.viewportTranslate[i] = view.getInt16(address + 8 + i * 2, false);
      }
      return;
    }
    if (index === 0x82 || index === 0x84) {
      const base = index === 0x84 ? 0 : 3;
      for (let i = 0; i < 3; i++) {
        this.lookAt[base + i] = view.getInt8(address + 8 + i);
      }
      this.lightsDirty = true;
      return;
    }
    if (index >= 0x86 && index <= 0x94 && (index & 1) === 0) {
      const light = (index - 0x86) >>> 1;
      for (let i = 0; i < 3; i++) {
        this.lightColor[light * 3 + i] = view.getUint8(address + i);
        this.lightDirection[light * 3 + i] = view.getInt8(address + 8 + i);
      }
      this.lightsDirty = true;
      return;
    }
    this.unsupported(`G_MOVEMEM index $${index.toString(16)} is not implemented.`);
  }

  private moveWord(w0: number, w1: number): void {
    const index = w0 & 0xff,
      offset = (w0 >>> 8) & 0xffff;
    switch (index) {
      case 0x02: // G_MW_NUMLIGHT: ((n + 1) * 32) | $80000000
        this.lightCount = Math.max(0, Math.min(7, ((w1 & 0x7fffffff) >>> 5) - 1));
        this.lightsDirty = true;
        return;
      case 0x04: // G_MW_CLIP: guard-band ratios. Only near clipping is visible.
        return;
      case 0x06: // G_MW_SEGMENT
        this.segments[(offset >>> 2) & 15] = w1 & 0xffffff;
        return;
      case 0x08: // G_MW_FOG: multiplier and offset
        this.fogMultiplier = w1 >> 16;
        this.fogOffset = (w1 << 16) >> 16;
        return;
      case 0x0a: {
        // G_MW_LIGHTCOL: offset selects the light and its color copy.
        const light = offset >>> 5;
        if ((offset & 7) === 0 && light < 8) {
          this.lightColor[light * 3] = w1 >>> 24;
          this.lightColor[light * 3 + 1] = (w1 >>> 16) & 255;
          this.lightColor[light * 3 + 2] = (w1 >>> 8) & 255;
        }
        return;
      }
      case 0x0e: // G_MW_PERSPNORM: W is normalized per triangle here.
        return;
      default:
        this.unsupported(`G_MOVEWORD index $${index.toString(16)} is not implemented.`);
    }
  }

  private otherMode(opcode: number, w0: number, w1: number): void {
    const shift = (w0 >>> 8) & 0xff,
      length = w0 & 0xff,
      mask = length >= 32 ? 0xffffffff : ((2 ** length - 1) * 2 ** shift) >>> 0;
    if (opcode === 0xba) {
      this.otherHigh = ((this.otherHigh & ~mask) | (w1 & mask)) & 0xffffff;
    } else {
      this.otherLow = ((this.otherLow & ~mask) | (w1 & mask)) >>> 0;
    }
    this.operations.push([(0xef000000 | this.otherHigh) >>> 0, this.otherLow]);
  }

  private updateCombined(): void {
    if (this.combinedDirty) {
      multiply(this.modelview, this.projection, this.combined);
      this.combinedDirty = false;
    }
  }

  /** Express light and look-at directions in model space, so they can be
   * compared with untransformed vertex normals. */
  private updateLights(): void {
    if (!this.lightsDirty) {
      return;
    }
    const m = this.modelview;
    const transform = (source: Float64Array, from: number, target: Float64Array, to: number) => {
      const x = source[from]!,
        y = source[from + 1]!,
        z = source[from + 2]!;
      let tx = m[0]! * x + m[1]! * y + m[2]! * z,
        ty = m[4]! * x + m[5]! * y + m[6]! * z,
        tz = m[8]! * x + m[9]! * y + m[10]! * z;
      const length = Math.hypot(tx, ty, tz);
      if (length > 0) {
        tx /= length;
        ty /= length;
        tz /= length;
      }
      target[to] = tx;
      target[to + 1] = ty;
      target[to + 2] = tz;
    };
    for (let light = 0; light < 8; light++) {
      transform(this.lightDirection, light * 3, this.modelLight, light * 3);
    }
    transform(this.lookAt, 0, this.modelLookAt, 0);
    transform(this.lookAt, 3, this.modelLookAt, 3);
    this.lightsDirty = false;
  }

  private loadVertices(w0: number, w1: number): void {
    const count = ((w0 >>> 20) & 15) + 1,
      first = (w0 >>> 16) & 15,
      address = this.address(w1),
      view = this.view;
    if (first + count > 16) {
      this.unsupported('A vertex load exceeds the 16-entry buffer.');
    }
    this.checkRange(address, count * 16);
    this.updateCombined();
    const geometry = this.geometry,
      lighting = (geometry & geometryLighting) !== 0,
      textureGen = (geometry & geometryTextureGen) !== 0,
      fog = (geometry & geometryFog) !== 0;
    if (lighting || textureGen) {
      this.updateLights();
    }
    const m = this.combined,
      out = this.vertices;
    for (let i = 0; i < count; i++) {
      const base = address + i * 16,
        o = (first + i) * attributes;
      const x = view.getInt16(base, false),
        y = view.getInt16(base + 2, false),
        z = view.getInt16(base + 4, false);
      const cx = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
        cy = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
        cz = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
        cw = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
      out[o + X] = cx;
      out[o + Y] = cy;
      out[o + Z] = cz;
      out[o + W] = cw;
      let s = view.getInt16(base + 8, false),
        t = view.getInt16(base + 10, false);
      out[o + A] = view.getUint8(base + 15);
      let nx = 0,
        ny = 0,
        nz = 0;
      if (lighting || textureGen) {
        nx = view.getInt8(base + 12);
        ny = view.getInt8(base + 13);
        nz = view.getInt8(base + 14);
        const length = Math.hypot(nx, ny, nz);
        if (length > 0) {
          nx /= length;
          ny /= length;
          nz /= length;
        }
      }
      if (lighting) {
        // The light after the directional lights is ambient.
        const ambient = this.lightCount * 3,
          color = this.lightColor,
          direction = this.modelLight;
        let r = color[ambient]!,
          g = color[ambient + 1]!,
          b = color[ambient + 2]!;
        for (let light = 0; light < this.lightCount; light++) {
          const l = light * 3,
            intensity = nx * direction[l]! + ny * direction[l + 1]! + nz * direction[l + 2]!;
          if (intensity > 0) {
            r += color[l]! * intensity;
            g += color[l + 1]! * intensity;
            b += color[l + 2]! * intensity;
          }
        }
        out[o + R] = Math.min(255, r);
        out[o + G] = Math.min(255, g);
        out[o + B] = Math.min(255, b);
      } else {
        out[o + R] = view.getUint8(base + 12);
        out[o + G] = view.getUint8(base + 13);
        out[o + B] = view.getUint8(base + 14);
      }
      if (textureGen) {
        const look = this.modelLookAt,
          dx = Math.max(-1, Math.min(1, nx * look[0]! + ny * look[1]! + nz * look[2]!)),
          dy = Math.max(-1, Math.min(1, nx * look[3]! + ny * look[4]! + nz * look[5]!));
        if (geometry & geometryTextureGenLinear) {
          s = Math.acos(dx) * (32768 / Math.PI);
          t = Math.acos(dy) * (32768 / Math.PI);
        } else {
          s = (dx + 1) * 16384;
          t = (dy + 1) * 16384;
        }
      }
      out[o + S] = s * this.textureScaleS;
      out[o + T] = t * this.textureScaleT;
      if (fog) {
        const ndc = cw > 0 ? cz / cw : cz >= 0 ? 1 : -1;
        out[o + A] = Math.max(0, Math.min(255, ndc * this.fogMultiplier + this.fogOffset));
      }
    }
  }

  /** G_CULLDL ends the list when every listed vertex lies outside the same
   * side of the view volume. */
  private culled(first: number, last: number): boolean {
    if (!Number.isInteger(first) || !Number.isInteger(last) || first > last || last > 15) {
      this.unsupported('G_CULLDL names an invalid vertex range.');
    }
    let outside = 0x3f;
    for (let i = first; i <= last; i++) {
      const o = i * attributes,
        x = this.vertices[o + X]!,
        y = this.vertices[o + Y]!,
        z = this.vertices[o + Z]!,
        w = this.vertices[o + W]!;
      outside &=
        (x < -w ? 1 : 0) |
        (x > w ? 2 : 0) |
        (y < -w ? 4 : 0) |
        (y > w ? 8 : 0) |
        (z < -w ? 16 : 0) |
        (z > w ? 32 : 0);
      if (!outside) {
        return false;
      }
    }
    return outside !== 0;
  }

  private triangle(w1: number): void {
    const a = ((w1 >>> 16) & 0xff) / 10,
      b = ((w1 >>> 8) & 0xff) / 10,
      c = (w1 & 0xff) / 10,
      flat = w1 >>> 24;
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      !Number.isInteger(c) ||
      a > 15 ||
      b > 15 ||
      c > 15
    ) {
      this.unsupported('G_TRI1 names an invalid vertex.');
    }
    const geometry = this.geometry;
    if (
      (geometry & (geometryCullFront | geometryCullBack)) ===
      (geometryCullFront | geometryCullBack)
    ) {
      return;
    }
    const polygon = this.polygon,
      vertices = this.vertices,
      indices = [a, b, c];
    for (let i = 0; i < 3; i++) {
      polygon.set(
        vertices.subarray(indices[i]! * attributes, indices[i]! * attributes + attributes),
        i * attributes,
      );
    }
    if (!(geometry & geometrySmooth)) {
      const source = indices[flat > 2 ? 0 : flat]! * attributes;
      for (let i = 0; i < 3; i++) {
        for (let k = R; k <= A; k++) {
          polygon[i * attributes + k] = vertices[source + k]!;
        }
      }
    }
    const count = this.clipNear(3);
    if (count < 3) {
      return;
    }
    this.project(this.clippedSource, count);
    for (let i = 1; i + 1 < count; i++) {
      this.setup(0, i, i + 1);
    }
  }

  /** Sutherland-Hodgman clipping against z >= -w. Attributes interpolate
   * linearly in clip space, so screen-space interpolation stays perspective
   * correct. Only the near plane changes which pixels are drawn; other planes
   * would only split triangles that the RDP scissor already bounds. */
  private clipNear(count: number): number {
    const input = this.polygon,
      output = this.clipped;
    let inside = 0;
    for (let i = 0; i < count; i++) {
      if (input[i * attributes + Z]! + input[i * attributes + W]! >= 0) {
        inside++;
      }
    }
    if (inside === count) {
      this.clippedSource = input;
      return count;
    }
    if (inside === 0) {
      return 0;
    }
    let produced = 0;
    for (let i = 0; i < count; i++) {
      const current = i * attributes,
        next = ((i + 1) % count) * attributes,
        dc = input[current + Z]! + input[current + W]!,
        dn = input[next + Z]! + input[next + W]!;
      if (dc >= 0) {
        output.set(input.subarray(current, current + attributes), produced * attributes);
        produced++;
      }
      if (dc >= 0 !== dn >= 0) {
        const t = dc / (dc - dn),
          o = produced * attributes;
        for (let k = 0; k < attributes; k++) {
          output[o + k] = input[current + k]! + (input[next + k]! - input[current + k]!) * t;
        }
        produced++;
      }
    }
    this.clippedSource = output;
    return produced;
  }

  /** Viewport transform to quarter-pixel screen coordinates. Fast3D flips Y.
   * Truncating toward negative infinity matched reference-tier edges best on
   * the castle fixture (1.7% of pixels differ by more than 24, versus 4.4%
   * when rounding to nearest). */
  private project(source: Float64Array, count: number): void {
    const scale = this.viewportScale,
      translate = this.viewportTranslate,
      out = this.screen;
    for (let i = 0; i < count; i++) {
      const v = i * attributes,
        p = i * projected,
        w = Math.max(source[v + W]!, 1e-6),
        inverse = 1 / w;
      out[p + PX] = Math.floor(translate[0]! + scale[0]! * source[v + X]! * inverse) / 4;
      out[p + PY] = Math.floor(translate[1]! - scale[1]! * source[v + Y]! * inverse) / 4;
      out[p + PZ] = (translate[2]! + scale[2]! * source[v + Z]! * inverse) * 32;
      out[p + PR] = source[v + R]!;
      out[p + PG] = source[v + G]!;
      out[p + PB] = source[v + B]!;
      out[p + PA] = source[v + A]!;
      out[p + PS] = source[v + S]!;
      out[p + PT] = source[v + T]!;
      out[p + PW] = w;
    }
  }

  /** Builds RDP edge and attribute coefficients for one screen triangle. */
  private setup(i0: number, i1: number, i2: number): void {
    const p = this.screen;
    const x0 = p[i0 * projected + PX]!,
      y0 = p[i0 * projected + PY]!,
      x1 = p[i1 * projected + PX]!,
      y1 = p[i1 * projected + PY]!,
      x2 = p[i2 * projected + PX]!,
      y2 = p[i2 * projected + PY]!;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) {
      return;
    }
    // Screen Y grows downward, so a counter-clockwise front face has a
    // negative area here.
    const geometry = this.geometry;
    if ((geometry & geometryCullBack && area > 0) || (geometry & geometryCullFront && area < 0)) {
      return;
    }
    // Sort by Y: top (H), middle (M), bottom (L).
    let top = i0,
      middle = i1,
      bottom = i2;
    if (p[middle * projected + PY]! < p[top * projected + PY]!) {
      [top, middle] = [middle, top];
    }
    if (p[bottom * projected + PY]! < p[middle * projected + PY]!) {
      [middle, bottom] = [bottom, middle];
    }
    if (p[middle * projected + PY]! < p[top * projected + PY]!) {
      [top, middle] = [middle, top];
    }
    const ht = top * projected,
      mt = middle * projected,
      lt = bottom * projected;
    const xh = p[ht + PX]!,
      yh = p[ht + PY]!,
      xm = p[mt + PX]!,
      ym = p[mt + PY]!,
      xl = p[lt + PX]!,
      yl = p[lt + PY]!;
    if (yl === yh) {
      return;
    }
    const dxh = (xl - xh) / (yl - yh),
      dxm = ym === yh ? 0 : (xm - xh) / (ym - yh),
      dxl = yl === ym ? 0 : (xl - xm) / (yl - ym),
      originY = Math.floor(yh),
      majorX = xh + dxh * (originY - yh);
    const shade = (geometry & geometryShade) !== 0,
      texture = this.textureOn,
      depth = (geometry & geometryZBuffer) !== 0;
    const triangle: RdpTriangle = {
      opcode: 8 | (shade ? 4 : 0) | (texture ? 2 : 0) | (depth ? 1 : 0),
      tile: this.textureTile,
      level: this.textureLevel,
      leftMajor: (xm - xh) * (yl - yh) - (xl - xh) * (ym - yh) > 0,
      yh,
      ym,
      yl,
      xh: majorX,
      xm: xh + dxm * (originY - yh),
      xl: xm,
      dxh,
      dxm,
      dxl,
    };
    // Plane through three (x, y, value) points, expressed at the major edge
    // on the first scanline: value + dx·(X − xh) + dy·(Y − y0), de = dy + dx·dxh.
    const det = (xm - xh) * (yl - yh) - (xl - xh) * (ym - yh);
    const plane = (values: readonly number[][]): RdpPlane => {
      const lanes = values[0]!.length,
        result: RdpPlane = { value: [], dx: [], de: [], dy: [] };
      for (let lane = 0; lane < lanes; lane++) {
        const vh = values[0]![lane]!,
          vm = values[1]![lane]!,
          vl = values[2]![lane]!;
        const ax = ((vm - vh) * (yl - yh) - (vl - vh) * (ym - yh)) / det,
          ay = ((vl - vh) * (xm - xh) - (vm - vh) * (xl - xh)) / det;
        result.value.push(vh + ax * (majorX - xh) + ay * (originY - yh));
        result.dx.push(ax);
        result.dy.push(ay);
        result.de.push(ay + ax * dxh);
      }
      return result;
    };
    if (shade) {
      triangle.shade = plane(
        [ht, mt, lt].map((v) => [p[v + PR]!, p[v + PG]!, p[v + PB]!, p[v + PA]!]),
      );
    }
    if (texture) {
      const perspective = (this.otherHigh & 0x80000) !== 0,
        nearest = Math.min(p[ht + PW]!, p[mt + PW]!, p[lt + PW]!);
      triangle.texture = plane(
        [ht, mt, lt].map((v) => {
          // The RDP divides S/W and T/W by W; normalize W to the nearest vertex.
          const k = perspective ? nearest / p[v + PW]! : 1;
          return [p[v + PS]! * k, p[v + PT]! * k, 32768 * k, 0];
        }),
      );
    }
    if (depth) {
      triangle.depth = plane([[p[ht + PZ]!], [p[mt + PZ]!], [p[lt + PZ]!]]);
    }
    this.operations.push(triangle);
    this.stats.triangles++;
  }
}

function identity(matrix: Float64Array): void {
  matrix.fill(0);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
}

function multiply(a: Float64Array, b: Float64Array, out: Float64Array): void {
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[row * 4 + k]! * b[k * 4 + column]!;
      }
      out[row * 4 + column] = sum;
    }
  }
}
