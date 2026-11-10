import { Diagnostic } from '../../contracts.js';

export type Mirroring = 'horizontal' | 'vertical' | 'single-low' | 'single-high';
export interface CartridgeData {
  mapper: number;
  mirroring: Mirroring;
  prg: readonly number[] | Uint8Array;
  chr: readonly number[] | Uint8Array;
}
export interface MapperState {
  shift: number;
  control: number;
  chr0: number;
  chr1: number;
  prg: number;
  lastWrite: number;
}

/** Cartridge wiring is independent of the PPU and the game's rules. Only NROM
 * and MMC1 are supported; the raw chip recipe supplies the board identity. */
export class NesCartridge {
  readonly prg: Uint8Array;
  readonly chr: Uint8Array;
  readonly chrRam: boolean;
  readonly ram = new Uint8Array(8192);
  readonly registers: MapperState = {
    shift: 0x10,
    control: 0x0c,
    chr0: 0,
    chr1: 0,
    prg: 0,
    lastWrite: -2,
  };
  constructor(readonly data: CartridgeData) {
    if (![0, 1].includes(data.mapper)) {
      throw new Diagnostic('NES_MAPPER', `Mapper ${data.mapper} is unsupported.`);
    }
    if (!['horizontal', 'vertical', 'single-low', 'single-high'].includes(data.mirroring)) {
      throw new Diagnostic('NES_MIRRORING', 'Unknown nametable wiring.');
    }
    if (
      !data.prg.length ||
      data.prg.length % 16384 ||
      data.prg.length > 262144 ||
      data.chr.length % 4096 ||
      data.chr.length > 131072 ||
      (data.mapper === 0 &&
        (![16384, 32768].includes(data.prg.length) || ![0, 8192].includes(data.chr.length)))
    ) {
      throw new Diagnostic('NES_CHIPS', 'Invalid PRG/CHR sizes for this board.');
    }
    this.prg = Uint8Array.from(data.prg);
    this.chrRam = data.chr.length === 0;
    this.chr = this.chrRam ? new Uint8Array(8192) : Uint8Array.from(data.chr);
  }
  prgOffset(address: number): number {
    const count = this.prg.length / 16384;
    if (this.data.mapper === 0) {
      return (address - 0x8000) % this.prg.length;
    }
    const mode = (this.registers.control >>> 2) & 3,
      upper = address >= 0xc000;
    const bank =
      mode < 2
        ? (this.registers.prg & 14) + Number(upper)
        : mode === 2
          ? upper
            ? this.registers.prg & 15
            : 0
          : upper
            ? count - 1
            : this.registers.prg & 15;
    return (bank % count) * 16384 + (address & 0x3fff);
  }
  readCpu(address: number): number {
    if (address >= 0x8000) {
      return this.prg[this.prgOffset(address)]!;
    }
    return this.ram[address & 8191]!;
  }
  writeCpu(address: number, value: number, cycle: number): void {
    if (address < 0x8000) {
      if (this.data.mapper !== 1 || !(this.registers.prg & 16)) {
        this.ram[address & 8191] = value;
      }
      return;
    }
    if (this.data.mapper === 0) {
      return;
    }
    const r = this.registers,
      previous = r.lastWrite;
    r.lastWrite = cycle;
    if (value & 128) {
      r.shift = 0x10;
      r.control |= 0x0c;
      return;
    }
    if (cycle === previous + 1) {
      return;
    } // Second write of an NMOS RMW.
    const complete = !!(r.shift & 1);
    r.shift = (r.shift >>> 1) | ((value & 1) << 4);
    if (!complete) {
      return;
    }
    const register = (address >>> 13) & 3;
    if (register === 0) {
      r.control = r.shift;
    } else if (register === 1) {
      r.chr0 = r.shift;
    } else if (register === 2) {
      r.chr1 = r.shift;
    } else {
      r.prg = r.shift;
    }
    r.shift = 0x10;
  }
  chrOffset(address: number): number {
    if (this.data.mapper === 0) {
      return address & 8191;
    }
    const r = this.registers,
      bank =
        r.control & 16
          ? address < 4096
            ? r.chr0
            : r.chr1
          : (r.chr0 & 30) + Number(address >= 4096);
    return (bank * 4096 + (address & 4095)) % this.chr.length;
  }
  readChr(address: number): number {
    return this.chr[this.chrOffset(address)]!;
  }
  writeChr(address: number, value: number): void {
    if (this.chrRam) {
      this.chr[this.chrOffset(address)] = value;
    }
  }
  nametableOffset(address: number): number {
    const table = (address >>> 10) & 3;
    const mirroring =
      this.data.mapper === 1
        ? (['single-low', 'single-high', 'vertical', 'horizontal'] as const)[
            this.registers.control & 3
          ]!
        : this.data.mirroring;
    const page =
      mirroring === 'vertical'
        ? table & 1
        : mirroring === 'horizontal'
          ? table >>> 1
          : Number(mirroring === 'single-high');
    return page * 1024 + (address & 1023);
  }
}
