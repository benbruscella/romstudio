import type { NesCartridge } from './cartridge.js';

// Digital preview colours. Composite decoding and PAL emphasis are unverified.
const COLOURS = [
  0x666666, 0x002a88, 0x1412a7, 0x3b00a4, 0x5c007e, 0x6e0040, 0x6c0600, 0x561d00, 0x333500,
  0x0b4800, 0x005200, 0x004f08, 0x00404d, 0x000000, 0x000000, 0x000000, 0xadadad, 0x155fd9,
  0x4240ff, 0x7527fe, 0xa01acc, 0xb71e7b, 0xb53120, 0x994e00, 0x6b6d00, 0x388700, 0x0c9300,
  0x008f32, 0x007c8d, 0x000000, 0x000000, 0x000000, 0xfffeff, 0x64b0ff, 0x9290ff, 0xc676ff,
  0xf36aff, 0xfe6ecc, 0xfe8170, 0xea9e22, 0xbcbe00, 0x88d800, 0x5ce430, 0x45e082, 0x48cdde,
  0x4f4f4f, 0x000000, 0x000000, 0xfffeff, 0xc0dfff, 0xd3d2ff, 0xe8c8ff, 0xfbc2ff, 0xfec4ea,
  0xfeccc5, 0xf7d8a5, 0xe4e594, 0xcfef96, 0xbdf4ab, 0xb3f3cc, 0xb5ebf2, 0xb8b8b8, 0x000000,
  0x000000,
];

/** PPU address/scroll latches, PAL beam and tile/sprite composition. Pattern
 * bytes come from cartridge wiring; names/palettes/OAM are separate memories.
 * Fetches are grouped at pixel/tile boundaries rather than electrical phases. */
export class NesPpu {
  readonly pixels = new Uint8Array(256 * 240 * 4);
  readonly nametables = new Uint8Array(2048);
  readonly palette = new Uint8Array(32);
  readonly oam = new Uint8Array(256).fill(255);
  ctrl = 0;
  mask = 0;
  status = 0;
  oamAddress = 0;
  v = 0;
  t = 0;
  fineX = 0;
  secondWrite = false;
  readBuffer = 0;
  latch = 0;
  line = 0;
  dot = 0;
  frames = 0;
  nmiPending = false;
  private lineBase = 0;
  private readonly spriteColour = new Uint8Array(256);
  private readonly spriteBehind = new Uint8Array(256);
  private readonly spriteZero = new Uint8Array(256);
  constructor(
    readonly cartridge: NesCartridge,
    readonly captureDisplay = true,
  ) {}
  private paletteOffset(address: number): number {
    let offset = address & 31;
    if ((offset & 19) === 16) {
      offset -= 16;
    }
    return offset;
  }
  readMemory(address: number): number {
    address &= 0x3fff;
    if (address < 0x2000) {
      return this.cartridge.readChr(address);
    }
    if (address < 0x3f00) {
      return this.nametables[this.cartridge.nametableOffset(address)]!;
    }
    return this.palette[this.paletteOffset(address)]!;
  }
  writeMemory(address: number, value: number): void {
    address &= 0x3fff;
    if (address < 0x2000) {
      this.cartridge.writeChr(address, value);
    } else if (address < 0x3f00) {
      this.nametables[this.cartridge.nametableOffset(address)] = value;
    } else {
      this.palette[this.paletteOffset(address)] = value & 63;
    }
  }
  readRegister(register: number): number {
    let value = this.latch;
    if (register === 2) {
      value = (this.status & 0xe0) | (this.latch & 31);
      this.status &= 0x7f;
      this.secondWrite = false;
    } else if (register === 4) {
      value = this.oam[this.oamAddress]!;
    } else if (register === 7) {
      const address = this.v & 0x3fff;
      value = address >= 0x3f00 ? this.readMemory(address) : this.readBuffer;
      this.readBuffer = this.readMemory(address >= 0x3f00 ? address - 0x1000 : address);
      this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7fff;
    }
    this.latch = value;
    return value;
  }
  writeRegister(register: number, value: number): void {
    this.latch = value;
    switch (register) {
      case 0:
        if (!(this.ctrl & 128) && value & 128 && this.status & 128) {
          this.nmiPending = true;
        }
        this.ctrl = value;
        this.t = (this.t & ~0xc00) | ((value & 3) << 10);
        break;
      case 1:
        this.mask = value;
        break;
      case 3:
        this.oamAddress = value;
        break;
      case 4:
        this.oam[this.oamAddress] = value;
        this.oamAddress = (this.oamAddress + 1) & 255;
        break;
      case 5:
        if (!this.secondWrite) {
          this.t = (this.t & ~31) | (value >>> 3);
          this.fineX = value & 7;
        } else {
          this.t = (this.t & ~0x73e0) | ((value & 7) << 12) | ((value & 0xf8) << 2);
        }
        this.secondWrite = !this.secondWrite;
        break;
      case 6:
        if (!this.secondWrite) {
          this.t = (this.t & 255) | ((value & 63) << 8);
        } else {
          this.t = (this.t & 0x7f00) | value;
          this.v = this.t;
        }
        this.secondWrite = !this.secondWrite;
        break;
      case 7:
        this.writeMemory(this.v, value);
        this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7fff;
        break;
    }
  }
  private incrementX(): void {
    if ((this.v & 31) === 31) {
      this.v = (this.v & ~31) ^ 0x400;
    } else {
      this.v++;
    }
  }
  private incrementY(): void {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
      return;
    }
    this.v &= ~0x7000;
    let row = (this.v >>> 5) & 31;
    if (row === 29) {
      row = 0;
      this.v ^= 0x800;
    } else {
      row = row === 31 ? 0 : row + 1;
    }
    this.v = (this.v & ~0x3e0) | (row << 5);
  }
  private prepareSprites(): void {
    this.spriteColour.fill(0);
    this.spriteBehind.fill(0);
    this.spriteZero.fill(0);
    const height = this.ctrl & 32 ? 16 : 8;
    let count = 0;
    for (let sprite = 0; sprite < 64; sprite++) {
      const at = sprite * 4,
        top = this.oam[at]! + 1;
      if (this.line < top || this.line >= top + height) {
        continue;
      }
      if (++count > 8) {
        this.status |= 32;
        break;
      }
      const tile = this.oam[at + 1]!,
        attributes = this.oam[at + 2]!,
        left = this.oam[at + 3]!;
      let row = this.line - top;
      if (attributes & 128) {
        row = height - 1 - row;
      }
      const address =
        height === 16
          ? (tile & 1) * 4096 + ((tile & 0xfe) + (row >>> 3)) * 16 + (row & 7)
          : (this.ctrl & 8 ? 4096 : 0) + tile * 16 + row;
      const low = this.cartridge.readChr(address),
        high = this.cartridge.readChr(address + 8);
      for (let column = 0; column < 8 && left + column < 256; column++) {
        const bit = attributes & 64 ? column : 7 - column,
          pattern = ((low >>> bit) & 1) | (((high >>> bit) & 1) << 1),
          x = left + column;
        if (!pattern || this.spriteColour[x]) {
          continue;
        }
        this.spriteColour[x] = 16 + (attributes & 3) * 4 + pattern;
        this.spriteBehind[x] = attributes & 32;
        this.spriteZero[x] = Number(sprite === 0);
      }
    }
  }
  private pixel(x: number): void {
    let background = 0;
    if (this.mask & 8 && (x >= 8 || this.mask & 2)) {
      // v has advanced past the two prefetched tiles at the left edge.
      const sourceX =
        ((this.lineBase & 31) * 8 + (this.lineBase & 0x400 ? 256 : 0) + 496 + this.fineX + x) & 511;
      const column = (sourceX >>> 3) & 31,
        row = (this.lineBase >>> 5) & 31,
        table = (sourceX >= 256 ? 0x400 : 0) | (this.lineBase & 0x800);
      const tile = this.readMemory(0x2000 | table | (row << 5) | column);
      const attributes = this.readMemory(0x23c0 | table | ((row >>> 2) << 3) | (column >>> 2));
      const shift = ((row & 2) << 1) | (column & 2);
      const address = (this.ctrl & 16 ? 4096 : 0) + tile * 16 + ((this.lineBase >>> 12) & 7),
        bit = 7 - (sourceX & 7);
      const pattern =
        ((this.cartridge.readChr(address) >>> bit) & 1) |
        (((this.cartridge.readChr(address + 8) >>> bit) & 1) << 1);
      if (pattern) {
        background = ((attributes >>> shift) & 3) * 4 + pattern;
      }
    }
    const sprite = this.mask & 16 && (x >= 8 || this.mask & 4) ? this.spriteColour[x]! : 0;
    if (sprite && background && this.spriteZero[x] && x !== 255) {
      this.status |= 64;
    }
    const index = sprite && (!background || !this.spriteBehind[x]) ? sprite : background;
    if (!this.captureDisplay) {
      return;
    }
    let colour = this.readMemory(0x3f00 + index);
    if (this.mask & 1) {
      colour &= 0x30;
    }
    const rgb = COLOURS[colour]!,
      at = (this.line * 256 + x) * 4;
    this.pixels[at] = rgb >>> 16;
    this.pixels[at + 1] = (rgb >>> 8) & 255;
    this.pixels[at + 2] = rgb & 255;
    this.pixels[at + 3] = 255;
  }
  tick(dots: number): void {
    for (let n = 0; n < dots; n++) {
      if (++this.dot === 341) {
        this.dot = 0;
        if (++this.line === 312) {
          this.line = 0;
          this.frames++;
        }
      }
      if (this.line === 241 && this.dot === 1) {
        this.status |= 128;
        if (this.ctrl & 128) {
          this.nmiPending = true;
        }
      }
      if (this.line === 311 && this.dot === 1) {
        this.status &= 31;
      }
      const render = !!(this.mask & 24),
        drawingLine = this.line < 240 || this.line === 311;
      if (this.line < 240 && this.dot === 1) {
        this.lineBase = this.v;
        this.prepareSprites();
      }
      if (this.line < 240 && this.dot >= 1 && this.dot <= 256) {
        this.pixel(this.dot - 1);
      }
      if (!render || !drawingLine) {
        continue;
      }
      if (
        (this.dot >= 8 && this.dot <= 256 && this.dot % 8 === 0) ||
        this.dot === 328 ||
        this.dot === 336
      ) {
        this.incrementX();
      }
      if (this.dot === 256) {
        this.incrementY();
      }
      if (this.dot === 257) {
        this.v = (this.v & ~0x41f) | (this.t & 0x41f);
      }
      if (this.line === 311 && this.dot >= 280 && this.dot <= 304) {
        this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
      }
    }
  }
  snapshot() {
    return {
      ctrl: this.ctrl,
      mask: this.mask,
      status: this.status,
      oamAddress: this.oamAddress,
      v: this.v,
      t: this.t,
      fineX: this.fineX,
      secondWrite: this.secondWrite,
      readBuffer: this.readBuffer,
      latch: this.latch,
      line: this.line,
      dot: this.dot,
      frames: this.frames,
      nmiPending: this.nmiPending,
      lineBase: this.lineBase,
      nametables: [...this.nametables],
      palette: [...this.palette],
      oam: [...this.oam],
      spriteColour: [...this.spriteColour],
      spriteBehind: [...this.spriteBehind],
      spriteZero: [...this.spriteZero],
    };
  }
}
