import { Vr4300Gap } from '../../runtime/vr4300.js';
import { N64Texture } from './texture.js';
import { decodeRdpTriangle, rasterizeRdpSpans, RdpSpan } from './rdp-triangle.js';
import { N64PixelPipeline } from './rdp-pixels.js';

/** RDP packets contain 64-bit words. Triangles add optional shade, texture
 * and depth coefficients; texture rectangles contain a second word. */
export function rdpCommandBytes(opcode: number): number {
  if (opcode >= 8 && opcode <= 15) {
    return 32 + (opcode & 4 ? 64 : 0) + (opcode & 2 ? 64 : 0) + (opcode & 1 ? 16 : 0);
  }
  return opcode === 0x24 || opcode === 0x25 ? 16 : 8;
}

/** Functional Display Processor FIFO and software rasterizer. Pixel-pipeline
 * precision has documented approximations; there is no hardware timing or
 * bit-exact whole-scene parity claim. */
export class N64Display {
  start = 0;
  end = 0;
  current = 0;
  status = 0x80; // Declared idle fixture, command buffer ready.
  private startPending = false;
  private readonly ramView: DataView;
  readonly stateWords = new Uint32Array(128);
  readonly texture = new N64Texture((kind, message) => this.gap(kind, message));
  readonly pixels: N64PixelPipeline;
  private readonly span = new RdpSpan();
  /** Debugger hook: runs at a complete draw packet before any pixel writes.
   * Hooks are execution controls, separate from serialized hardware state. */
  beforeDraw: ((command: { address: number; opcode: number; bytes: number }) => void) | undefined;
  readonly triangles: {
    address: number;
    opcode: number;
    tile: number;
    fragments: number;
    written: number;
  }[] = [];
  readonly commands: { address: number; high: number; low: number }[] = [];
  readonly fills: {
    address: number;
    width: number;
    size: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    color: number;
  }[] = [];
  colorImage = { format: 0, size: 0, width: 1, address: 0 };
  scissor = { left: 0, top: 0, right: 0, bottom: 0 };
  modeHigh = 0;
  modeLow = 0;
  fillColor = 0;
  fullSyncs = 0;

  constructor(
    ram: Uint8Array,
    private readonly signalByte: (address: number) => number,
    private readonly interrupt: () => void,
  ) {
    this.ramView = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    this.pixels = new N64PixelPipeline(
      this.ramView,
      this.texture,
      this.stateWords,
      (kind, message) => this.gap(kind, message),
    );
  }

  read(offset: number): number {
    switch (offset) {
      case 0:
        return this.start;
      case 4:
        return this.end;
      case 8:
        return this.current;
      case 12:
        return this.status | (this.startPending ? 0x400 : 0);
      default:
        throw new Vr4300Gap(
          'rdp-register',
          0,
          0x04100000 + offset,
          'RDP counters are not implemented.',
        );
    }
  }

  write(offset: number, value: number): void {
    if (offset === 0) {
      this.start = value & 0xfffff8;
      this.startPending = true;
    } else if (offset === 4) {
      this.end = value & 0xfffff8;
      if (this.startPending) {
        this.current = this.start;
        this.startPending = false;
      }
      this.consume();
    } else if (offset === 12) {
      for (const [clear, set, flag] of [
        [1, 2, 1],
        [4, 8, 2],
        [16, 32, 4],
      ]) {
        if (value & clear!) {
          this.status &= ~flag!;
        }
        if (value & set!) {
          this.status |= flag!;
        }
      }
      this.consume();
    } else {
      throw new Vr4300Gap(
        'rdp-register',
        0,
        0x04100000 + offset,
        'This RDP register is read-only or unimplemented.',
      );
    }
  }

  private gap(kind: string, detail: string): never {
    throw new Vr4300Gap(kind, 0, this.current, detail);
  }

  private consume(): void {
    if ((this.status & 2) !== 0) {
      return;
    }
    if (this.current !== this.end && (this.status & 4) !== 0) {
      this.gap('rdp-flush', 'Flushing an active command range is not implemented.');
    }
    if (this.current > this.end) {
      this.gap('rdp-range', 'The RDP command range runs backwards; reset START before wrapping.');
    }
    while (this.current < this.end) {
      const word = (address: number) => {
        if (this.status & 1) {
          let value = 0;
          for (let i = 0; i < 4; i++) {
            value = (value << 8) | this.signalByte((address + i) & 0xfff);
          }
          return value >>> 0;
        }
        if (address + 4 > this.ramView.byteLength) {
          this.gap('rdp-range', 'RDP command bytes exceed installed RDRAM.');
        }

        return this.ramView.getUint32(address, false);
      };
      const high = word(this.current),
        low = word(this.current + 4);
      const opcode = (high >>> 24) & 63,
        bytes = rdpCommandBytes(opcode);
      // END can publish only part of a multiword packet. Keep CURRENT at
      // its header until the producer supplies the remaining words.
      if (this.end - this.current < bytes) {
        return;
      }
      for (let offset = 8; offset < bytes; offset += 4) {
        word(this.current + offset);
      }
      if (opcode >= 8 && opcode <= 15) {
        this.beforeDraw?.({ address: this.current, opcode, bytes });
        this.drawTriangle(
          Array.from({ length: bytes / 4 }, (_, index) => word(this.current + index * 4)),
        );
      } else {
        if (opcode === 0x24 || opcode === 0x25) {
          this.beforeDraw?.({ address: this.current, opcode, bytes });
        }
        this.execute(
          high,
          low,
          bytes > 8 ? word(this.current + 8) : 0,
          bytes > 8 ? word(this.current + 12) : 0,
        );
      }
      this.commands.push({ address: this.current, high, low });
      this.current += bytes;
    }
  }

  private execute(high: number, low: number, secondHigh = 0, secondLow = 0): void {
    const opcode = (high >>> 24) & 63;
    switch (opcode) {
      case 0: // RDP no-op.
      case 0x26: // Load, pipe and tile synchronization in the functional model.
      case 0x27:
      case 0x28:
        break;
      case 0x29: // FullSync is the DP completion event seen by the guest OS.
        this.fullSyncs++;
        this.interrupt();
        break;
      case 0x2f:
        this.modeHigh = high & 0xffffff;
        this.modeLow = low;
        break;
      case 0x2d:
        if ((high & 0x3003) !== 0 || (low & 0x03003003) !== 0) {
          this.gap('rdp-scissor', 'Fractional/interlaced scissoring is not implemented.');
        }
        this.scissor = {
          left: (high >>> 14) & 1023,
          top: (high >>> 2) & 1023,
          right: (low >>> 14) & 1023,
          bottom: (low >>> 2) & 1023,
        };
        break;
      case 0x3f:
        this.colorImage = {
          format: (high >>> 21) & 7,
          size: (high >>> 19) & 3,
          width: (high & 1023) + 1,
          address: low & 0x3ffffff,
        };
        break;
      case 0x3d:
        this.texture.setImage(high, low);
        break;
      case 0x35:
        this.texture.setTile(high, low);
        break;
      case 0x32:
        this.texture.setSize(high, low);
        break;
      case 0x33:
        this.texture.loadBlock(high, low, this.ramView);
        break;
      case 0x37:
        this.fillColor = low;
        break;
      case 0x36:
        this.fillRectangle(high, low);
        break;
      case 0x24:
      case 0x25:
        this.drawTextureRectangle(high, low, secondHigh, secondLow);
        break;
      case 0x3c: // Combine and depth-image state are retained for later drawing.
      case 0x3e:
      case 0x38: // Fog, blend, primitive/environment colors and primitive depth.
      case 0x39:
      case 0x3a:
      case 0x3b:
      case 0x2e:
        break;
      default:
        this.gap('rdp-command', `RDP command $${opcode.toString(16)} is not implemented.`);
    }
    this.stateWords[opcode * 2] = high;
    this.stateWords[opcode * 2 + 1] = low;
  }

  private drawTextureRectangle(
    high: number,
    low: number,
    coordinates: number,
    derivatives: number,
  ): void {
    const cycle = (this.modeHigh >>> 20) & 3;
    if (cycle === 3) {
      this.gap('rdp-texture-rectangle', 'A textured rectangle cannot use fill cycle.');
    }
    const left = ((low >>> 12) & 4095) / 4,
      top = (low & 4095) / 4;
    const right = ((high >>> 12) & 4095) / 4 + (cycle === 2 ? 1 : 0),
      bottom = (high & 4095) / 4 + (cycle === 2 ? 1 : 0);
    const tile = (low >>> 24) & 7,
      s = coordinates >> 16,
      t = (coordinates << 16) >> 16,
      ds = derivatives >> 16,
      dt = (derivatives << 16) >> 16;
    const flip = ((high >>> 24) & 63) === 0x25,
      span = this.span,
      writer = this.pixels.prepare(this, tile, cycle === 2);
    span.textured = true;
    span.depth = false;
    span.dz = 0;
    span.left = Math.max(this.scissor.left, Math.ceil(left));
    span.right = Math.min(this.colorImage.width, this.scissor.right, Math.ceil(right));
    for (
      let y = Math.max(this.scissor.top, Math.ceil(top));
      y < Math.min(this.scissor.bottom, Math.ceil(bottom));
      y++
    ) {
      span.y = y;
      for (let x = span.left; x < span.right; x++) {
        const offset = x * 8;
        span.coverage[x] = 8;
        span.values[offset] =
          span.values[offset + 1] =
          span.values[offset + 2] =
          span.values[offset + 3] =
            0;
        span.values[offset + 4] = s + ((flip ? y - top : x - left) * ds) / (cycle === 2 ? 128 : 32);
        span.values[offset + 5] = t + ((flip ? x - left : y - top) * dt) / 32;
        span.values[offset + 6] = 32768;
      }
      writer.write(span);
    }
  }

  private drawTriangle(words: number[]): void {
    const cycle = (this.modeHigh >>> 20) & 3;
    if (cycle > 1) {
      this.gap('rdp-triangle-cycle', 'Triangles require a one- or two-cycle pixel pipeline.');
    }
    const triangle = decodeRdpTriangle(words);
    if (triangle.level !== 0 || (this.modeHigh & 0x70000) !== 0) {
      this.gap('rdp-texture-lod', 'Detail/sharpen/mipmap texture sampling is not implemented.');
    }
    if (triangle.yh > triangle.ym || triangle.ym > triangle.yl) {
      this.gap('rdp-triangle-edges', 'Triangle Y edges are not ordered.');
    }
    const previous = this.pixels.written;
    const writer = this.pixels.prepare(this, triangle.tile);
    const fragments = rasterizeRdpSpans(
      triangle,
      this.scissor,
      this.colorImage.width,
      (this.modeLow & 8) !== 0,
      this.span,
      (span) => writer.write(span),
    );
    this.triangles.push({
      address: this.current,
      opcode: triangle.opcode,
      tile: triangle.tile,
      fragments,
      written: this.pixels.written - previous,
    });
  }

  private fillRectangle(high: number, low: number): void {
    if (((this.modeHigh >>> 20) & 3) !== 3 || high & 0x3003 || low & 0x3003) {
      this.gap('rdp-fill-cycle', 'Only integer rectangles in fill cycle are implemented.');
    }
    const image = this.colorImage,
      scissor = this.scissor;
    if (image.format !== 0 || image.size < 2) {
      this.gap('rdp-color-format', 'Fill output currently requires RGBA16 or RGBA32.');
    }
    const bytes = image.size === 2 ? 2 : 4;
    // Fill-cycle rectangle endpoints are inclusive; scissor endpoints are exclusive.
    const left = Math.max((low >>> 14) & 1023, scissor.left),
      top = Math.max((low >>> 2) & 1023, scissor.top),
      right = Math.min(((high >>> 14) & 1023) + 1, scissor.right, image.width),
      bottom = Math.min(((high >>> 2) & 1023) + 1, scissor.bottom);
    if (left >= right || top >= bottom) {
      return;
    }
    if (
      image.address % bytes !== 0 ||
      image.address + ((bottom - 1) * image.width + right) * bytes > this.ramView.byteLength
    ) {
      this.gap('rdp-framebuffer', 'The fill rectangle exceeds or misaligns its RDRAM color image.');
    }
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const address = image.address + (y * image.width + x) * bytes;
        if (bytes === 2) {
          this.ramView.setUint16(
            address,
            address & 2 ? this.fillColor & 65535 : this.fillColor >>> 16,
            false,
          );
        } else {
          this.ramView.setUint32(address, this.fillColor, false);
        }
        this.pixels.fillHidden(
          address,
          bytes,
          bytes === 2
            ? address & 2
              ? this.fillColor & 65535
              : this.fillColor >>> 16
            : this.fillColor,
        );
      }
    }
    this.fills.push({ ...image, left, top, right, bottom, color: this.fillColor });
  }

  snapshot() {
    return {
      start: this.start,
      end: this.end,
      current: this.current,
      status: this.status,
      startPending: this.startPending,
      stateWords: [...this.stateWords],
      commands: this.commands.map((command) => ({ ...command })),
      fills: this.fills.map((fill) => ({ ...fill })),
      colorImage: { ...this.colorImage },
      scissor: { ...this.scissor },
      modeHigh: this.modeHigh,
      modeLow: this.modeLow,
      fillColor: this.fillColor,
      fullSyncs: this.fullSyncs,
      texture: this.texture.snapshot(),
      pixels: this.pixels.snapshot(),
      triangles: this.triangles.map((triangle) => ({ ...triangle })),
    };
  }

  restore(state: ReturnType<N64Display['snapshot']>): void {
    this.start = state.start;
    this.end = state.end;
    this.current = state.current;
    this.status = state.status;
    this.startPending = state.startPending;
    this.stateWords.set(state.stateWords);
    this.commands.length = 0;
    for (const command of state.commands) {
      this.commands.push({ ...command });
    }
    this.fills.length = 0;
    for (const fill of state.fills) {
      this.fills.push({ ...fill });
    }
    this.colorImage = { ...state.colorImage };
    this.scissor = { ...state.scissor };
    this.modeHigh = state.modeHigh;
    this.modeLow = state.modeLow;
    this.fillColor = state.fillColor;
    this.fullSyncs = state.fullSyncs;
    this.texture.restore(state.texture);
    this.pixels.restore(state.pixels);
    this.triangles.length = 0;
    for (const triangle of state.triangles) {
      this.triangles.push({ ...triangle });
    }
  }
}
