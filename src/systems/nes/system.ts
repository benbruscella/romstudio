import { Diagnostic } from '../../contracts.js';
import { ExecutionGap, type Machine, type Bus } from '../../runtime/mos6502.js';
import { NesCartridge, type CartridgeData } from './cartridge.js';
import { NesPpu } from './ppu.js';
import { NesApu } from './apu.js';

export { NES_PAL_CPU_HZ, NES_PAL_FRAME_CYCLES } from './timing.js';
export interface NesLaunch {
  version: 1;
  system: 'nes';
  timing: 'pal-2a07';
  ramFill: number;
  cartridge: CartridgeData;
}

/** CPU address decoder. RAM, PPU ports, controllers and cartridge wiring are
 * separate devices; a game never receives direct host movement or tile edits. */
export class NesSystemBus implements Bus {
  readonly decimalArithmetic = false;
  readonly ram = new Uint8Array(2048);
  readonly apu = new NesApu();
  readonly cartridge: NesCartridge;
  readonly ppu: NesPpu;
  clock = 0;
  ppuFraction = 0;
  openBus = 0;
  irqEntries = 0;
  nmiEntries = 0;
  dmcStallCycles = 0;
  dmaPending = 0;
  pad1 = 0;
  pad2 = 0;
  strobe = false;
  shift1 = 0;
  shift2 = 0;
  index1 = 0;
  index2 = 0;
  onControllerLatch: (() => void) | undefined;
  constructor(launch: NesLaunch, captureDisplay = true) {
    if (
      launch.version !== 1 ||
      launch.system !== 'nes' ||
      launch.timing !== 'pal-2a07' ||
      !Number.isInteger(launch.ramFill) ||
      launch.ramFill < 0 ||
      launch.ramFill > 255
    ) {
      throw new Diagnostic('NES_LAUNCH', 'Invalid NES launch fixture.');
    }
    this.cartridge = new NesCartridge(launch.cartridge);
    this.ppu = new NesPpu(this.cartridge, captureDisplay);
    this.ram.fill(launch.ramFill);
  }
  cpuCycle = (cycle: number, write: boolean, opcodeFetch = false): number => {
    this.advanceTo(cycle);
    const address = this.apu.dmc.dmaAddress;
    if (!write && opcodeFetch && address !== undefined && cycle >= this.apu.dmc.dmaReadyAt) {
      // PAL 2A07 halts on SYNC, not arbitrary reads: this prevents DPCM from
      // repeating a controller-register read. Halt/dummy/alignment/get consume
      // 3/4 cycles. Fine DMC/OAM overlap and interrupt-entry races are unverified.
      const stalls = cycle & 1 ? 4 : 3;
      this.advanceTo(cycle + stalls - 1);
      this.apu.dmc.complete(this.cartridge.readCpu(address));
      this.advanceTo(cycle + stalls);
      this.dmcStallCycles += stalls;
      return stalls;
    }
    return 0;
  };
  advanceTo(cycle: number): void {
    if (cycle < this.clock) {
      throw new Error('NES clock cannot move backwards.');
    }
    const elapsed = cycle - this.clock;
    this.clock = cycle;
    const dots = this.ppuFraction + elapsed * 16;
    this.ppuFraction = dots % 5;
    this.ppu.tick(Math.floor(dots / 5));
    this.apu.advanceTo(cycle);
  }
  read(address: number): number {
    let value: number;
    if (address < 0x2000) {
      value = this.ram[address & 2047]!;
    } else if (address < 0x4000) {
      value = this.ppu.readRegister(address & 7);
    } else if (address === 0x4016 || address === 0x4017) {
      const first = address === 0x4016,
        index = first ? this.index1 : this.index2;
      const bits = this.strobe
        ? first
          ? this.pad1
          : this.pad2
        : first
          ? this.shift1
          : this.shift2;
      value =
        (this.openBus & 0xe0) | (this.strobe ? bits & 1 : index < 8 ? (bits >>> index) & 1 : 1);
      if (!this.strobe) {
        if (first) {
          this.index1 = Math.min(8, index + 1);
        } else {
          this.index2 = Math.min(8, index + 1);
        }
      }
    } else if (address === 0x4015) {
      // This internal register leaves the external CPU data bus unchanged.
      return this.apu.readStatus() | (this.openBus & 32);
    } else if (address < 0x4018) {
      value = this.openBus;
    } else if (address >= 0x6000) {
      value = this.cartridge.readCpu(address);
    } else {
      throw new ExecutionGap('nes-expansion', address, 'No expansion device is mapped here.');
    }
    this.openBus = value;
    return value;
  }
  write(address: number, value: number): void {
    this.openBus = value;
    if (address < 0x2000) {
      this.ram[address & 2047] = value;
    } else if (address < 0x4000) {
      this.ppu.writeRegister(address & 7, value);
    } else if (address === 0x4014) {
      for (let offset = 0; offset < 256; offset++) {
        this.ppu.oam[(this.ppu.oamAddress + offset) & 255] = this.read(value * 256 + offset);
      }
      this.dmaPending += 513 + (this.clock & 1);
    } else if (address === 0x4016) {
      this.strobe = !!(value & 1);
      if (this.strobe) {
        this.onControllerLatch?.();
      }
      this.shift1 = this.pad1;
      this.shift2 = this.pad2;
      this.index1 = this.index2 = 0;
    } else if (address < 0x4018) {
      this.apu.write(address, value);
    } else if (address >= 0x6000) {
      this.cartridge.writeCpu(address, value, this.clock);
    } else {
      throw new ExecutionGap('nes-expansion', address, 'No expansion device accepts this write.');
    }
  }
  peek(address: number): number {
    if (address < 0x2000) {
      return this.ram[address & 2047]!;
    }
    if (address >= 0x6000) {
      return this.cartridge.readCpu(address);
    }
    throw new ExecutionGap(
      'nes-device-execution',
      address,
      'Instructions cannot execute from a device register.',
    );
  }
  boundary(machine: Machine): boolean {
    this.advanceTo(machine.cycles);
    if (this.dmaPending) {
      const cycles = this.dmaPending;
      this.dmaPending = 0;
      for (let cycle = 0; cycle < cycles; cycle++) {
        const waits = this.cpuCycle(machine.cycles, !!(machine.cycles & 1));
        machine.cycles += 1 + waits;
      }
      this.advanceTo(machine.cycles);
      return true;
    }
    const nmi = this.ppu.nmiPending;
    if (!nmi && !(this.apu.irq && !(machine.p & 4))) {
      return false;
    }
    if (nmi) {
      this.ppu.nmiPending = false;
    }
    machine.push(machine.pc >>> 8);
    machine.push(machine.pc & 255);
    machine.push((machine.p | 32) & ~16);
    machine.flag(4, true);
    const vector = nmi ? 0xfffa : 0xfffe;
    machine.pc = this.peek(vector) | (this.peek(vector + 1) << 8);
    machine.cycles += 7;
    if (nmi) {
      this.nmiEntries++;
    } else {
      this.irqEntries++;
    }
    this.advanceTo(machine.cycles);
    return true;
  }
  memoryImage() {
    const ram = new Uint8Array(65536),
      known = new Uint8Array(65536);
    for (let address = 0; address < 0x2000; address++) {
      ram[address] = this.ram[address & 2047]!;
      known[address] = 1;
    }
    for (let address = 0x6000; address < 65536; address++) {
      ram[address] = this.cartridge.readCpu(address);
      known[address] = 1;
    }
    return { ram, known };
  }
  snapshot() {
    return {
      clock: this.clock,
      ppuFraction: this.ppuFraction,
      openBus: this.openBus,
      irqEntries: this.irqEntries,
      nmiEntries: this.nmiEntries,
      dmcStallCycles: this.dmcStallCycles,
      dmaPending: this.dmaPending,
      ram: [...this.ram],
      apu: this.apu.snapshot(),
      mapper: { ...this.cartridge.registers },
      prgRam: [...this.cartridge.ram],
      chrRam: this.cartridge.chrRam ? [...this.cartridge.chr] : [],
      ppu: this.ppu.snapshot(),
      pad1: this.pad1,
      pad2: this.pad2,
      strobe: this.strobe,
      shift1: this.shift1,
      shift2: this.shift2,
      index1: this.index1,
      index2: this.index2,
    };
  }
}
