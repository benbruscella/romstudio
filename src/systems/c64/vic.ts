import { ExecutionGap } from '../../runtime/mos6502.js';
/** PAL raster register service. The clock is deterministic; DMA stalls, sprite
 * collisions and sub-instruction bus phases remain separate hardware work. */
export class VicII {
  readonly registers = new Uint8Array(64);
  cycles = 0;
  rasterCompare = 0;
  irqFlags = 0;
  irqMask = 0;
  constructor() {
    this.registers[0x11] = 0x1b;
    this.registers[0x16] = 0x08;
    this.registers[0x18] = 0x14;
  }
  get raster(): number {
    return Math.floor(this.cycles / 63) % 312;
  }
  get irq(): boolean {
    return !!(this.irqFlags & this.irqMask & 15);
  }
  advance(cycles: number): void {
    if (!Number.isInteger(cycles) || cycles < 0) {
      throw new Error('VIC clock must advance by whole non-negative cycles.');
    }
    const before = Math.floor(this.cycles / 63),
      after = Math.floor((this.cycles + cycles) / 63);
    if (this.rasterCompare < 312 && after > before) {
      const next = before + ((this.rasterCompare - (before % 312) + 311) % 312) + 1;
      if (next <= after) {
        this.irqFlags |= 1;
      }
    }
    this.cycles += cycles;
  }
  read(register: number): number {
    const r = register & 63;
    if (r >= 0x2f) {
      return 255;
    }
    if ([0x13, 0x14, 0x1e, 0x1f].includes(r)) {
      throw new ExecutionGap(
        'vic-feature',
        0xd000 + r,
        'Light pen and sprite collision reads are not modelled.',
      );
    }
    if (r === 0x11) {
      return (this.registers[r]! & 127) | ((this.raster & 256) >>> 1);
    }
    if (r === 0x12) {
      return this.raster & 255;
    }
    if (r === 0x16) {
      return this.registers[r]! | 0xc0;
    }
    if (r === 0x18) {
      return this.registers[r]! | 1;
    }
    if (r === 0x19) {
      return this.irqFlags | 0x70 | (this.irq ? 128 : 0);
    }
    if (r === 0x1a) {
      return this.irqMask | 0xf0;
    }
    if (r >= 0x20) {
      return (this.registers[r]! & 15) | 0xf0;
    }
    return this.registers[r]!;
  }
  write(register: number, value: number): void {
    const r = register & 63;
    value &= 255;
    if (r >= 0x2f) {
      return;
    }
    if (r === 0x11) {
      this.rasterCompare = (this.rasterCompare & 255) | ((value & 128) << 1);
    }
    if (r === 0x12) {
      this.rasterCompare = (this.rasterCompare & 256) | value;
      return;
    }
    if (r === 0x19) {
      this.irqFlags &= ~(value & 15);
      return;
    }
    if (r === 0x1a) {
      this.irqMask = value & 15;
      return;
    }
    this.registers[r] = r >= 0x20 ? value & 15 : value;
  }
}
