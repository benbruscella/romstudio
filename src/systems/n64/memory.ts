import { Vr4300Gap, Vr4300Ram, type Vr4300Memory } from '../../runtime/vr4300.js';
import { N64Interrupts } from './interrupts.js';
import { N64Video } from './video.js';
import { N64Peripheral } from './peripheral.js';
import { N64Serial } from './serial.js';
import { N64Audio } from './audio.js';
import { N64Signal } from './signal.js';
import { N64Display } from './display.js';

/** CPU-visible N64 memory. Addresses are physical or the unmapped KSEG0/KSEG1
 * aliases. TLB-mapped virtual addresses must be translated by the CPU first. */
export class N64Memory implements Vr4300Memory {
  /** Clock owner synchronizes elapsed device time before MMIO/inspection. */
  beforeDeviceAccess: (() => void) | undefined;

  readonly ram = new Vr4300Ram();
  private readonly ramView = new DataView(
    this.ram.bytes.buffer,
    this.ram.bytes.byteOffset,
    this.ram.bytes.byteLength,
  );
  readonly pif = new Uint8Array(64);
  readonly interrupts = new N64Interrupts();
  readonly display = new N64Display(
    this.ram.bytes,
    (address) => this.signal.memory[address & 0xfff]!,
    () => {
      this.interrupts.pending |= 32;
    },
  );
  readonly video = new N64Video(() => {
    this.interrupts.pending |= 8;
  });
  readonly peripheral: N64Peripheral;
  readonly serial: N64Serial;
  readonly audio = new N64Audio(this.ram.bytes, (asserted) => {
    this.interrupts.pending = asserted ? this.interrupts.pending | 4 : this.interrupts.pending & ~4;
  });
  readonly signal = new N64Signal(this.ram.bytes, (asserted) => {
    this.interrupts.pending = asserted ? this.interrupts.pending | 1 : this.interrupts.pending & ~1;
  });
  private readonly pifView = new DataView(this.pif.buffer);
  private readonly cartridge: Uint8Array;
  private readonly cartridgeView: DataView;
  readonly accesses: { write: boolean; address: number; value: number }[] = [];

  constructor(cartridge: Uint8Array, eepromBytes: 0 | 512 | 2048 = 0) {
    this.cartridge = cartridge.slice();
    this.cartridgeView = new DataView(this.cartridge.buffer);
    this.peripheral = new N64Peripheral(this.ram.bytes, this.cartridge, (asserted) => {
      this.interrupts.pending = asserted
        ? this.interrupts.pending | 16
        : this.interrupts.pending & ~16;
    });
    this.serial = new N64Serial(
      this.ram.bytes,
      this.pif,
      (asserted) => {
        this.interrupts.pending = asserted
          ? this.interrupts.pending | 2
          : this.interrupts.pending & ~2;
      },
      eepromBytes,
    );
  }

  private physical(address: number, size: number): number {
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff || address % size !== 0) {
      throw new Vr4300Gap('address-error', 0, address, 'Unaligned or invalid N64 memory address.');
    }
    if (address >= 0x80000000 && address < 0xc0000000) {
      return address & 0x1fffffff;
    }
    if (address >= 0x20000000) {
      throw new Vr4300Gap('virtual-memory', 0, address, 'This address needs CPU TLB translation.');
    }
    return address;
  }

  private region(address: number, size: number) {
    const physical = this.physical(address, size);
    if (physical + size <= this.ram.bytes.length) {
      return { kind: 'ram' as const, offset: physical };
    }
    if (physical >= 0x10000000 && physical - 0x10000000 + size <= this.cartridge.length) {
      return { kind: 'rom' as const, offset: physical - 0x10000000 };
    }
    if (physical >= 0x1fc007c0 && physical + size <= 0x1fc00800) {
      return { kind: 'pif' as const, offset: physical - 0x1fc007c0 };
    }
    if (physical >= 0x04000000 && physical + size <= 0x04002000) {
      return { kind: 'signal' as const, offset: physical - 0x04000000 };
    }
    return { kind: 'device' as const, offset: physical };
  }

  private readDevice(address: number): number {
    this.beforeDeviceAccess?.();
    let value: number;
    if (address >= 0x04040000 && address <= 0x0404001c) {
      value = this.signal.read(address - 0x04040000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    if (address === 0x04080000) {
      return this.signal.pc;
    }
    if (address >= 0x04100000 && address <= 0x0410001c) {
      value = this.display.read(address - 0x04100000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    if (address >= 0x04400000 && address <= 0x04400034) {
      value = this.video.read(address - 0x04400000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    if (address >= 0x04600000 && address <= 0x04600030) {
      value = this.peripheral.read(address - 0x04600000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    if (address >= 0x04500000 && address <= 0x04500014) {
      value = this.audio.read(address - 0x04500000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    if ([0x04800000, 0x04800018].includes(address)) {
      value = this.serial.read(address - 0x04800000);
      this.accesses.push({ write: false, address, value });
      return value;
    }
    switch (address) {
      case 0x04300000:
        value = this.interrupts.mode;
        break;
      case 0x04300004:
        value = 0x02020102;
        break;
      case 0x04300008:
        value = this.interrupts.pending;
        break;
      case 0x0430000c:
        value = this.interrupts.mask;
        break;
      case 0x05000508: // No 64DD attached: the presence bit reads high.
        value = 0xffffffff;
        break;
      default:
        throw new Vr4300Gap(
          'unimplemented-device',
          0,
          address,
          'N64 device read is not implemented.',
        );
    }
    this.accesses.push({ write: false, address, value });
    return value;
  }

  private writeDevice(address: number, value: number): void {
    this.beforeDeviceAccess?.();
    const word = value >>> 0;
    if (address >= 0x04040000 && address <= 0x0404001c) {
      this.signal.write(address - 0x04040000, word);
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    if (address === 0x04080000) {
      this.signal.pc = word & 0xffc;
      return;
    }
    if (address >= 0x04100000 && address <= 0x0410001c) {
      this.display.write(address - 0x04100000, word);
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    if (address >= 0x04400000 && address <= 0x04400034) {
      if (this.video.write(address - 0x04400000, word)) {
        this.interrupts.pending &= ~8;
      }
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    if (address >= 0x04600000 && address <= 0x04600030) {
      this.peripheral.write(address - 0x04600000, word);
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    if (address >= 0x04500000 && address <= 0x04500014) {
      this.audio.write(address - 0x04500000, word);
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    if ([0x04800000, 0x04800004, 0x04800010, 0x04800018].includes(address)) {
      this.serial.write(address - 0x04800000, word);
      this.accesses.push({ write: true, address, value: word });
      return;
    }
    switch (address) {
      case 0x04300000:
        this.interrupts.writeMode(word);
        break;
      case 0x0430000c:
        this.interrupts.writeMask(word);
        break;
      default:
        throw new Vr4300Gap(
          'unimplemented-device',
          0,
          address,
          'N64 device write is not implemented.',
        );
    }
    this.accesses.push({ write: true, address, value: word });
  }

  read8(address: number): number {
    const region = this.region(address, 1);
    if (region.kind === 'ram') {
      return this.ram.read8(region.offset);
    }
    if (region.kind === 'rom') {
      return this.cartridgeView.getUint8(region.offset);
    }
    if (region.kind === 'pif') {
      return this.pifView.getUint8(region.offset);
    }
    if (region.kind === 'signal') {
      return this.signal.view.getUint8(region.offset);
    }
    throw new Vr4300Gap('device-access-width', 0, address, 'N64 device reads require a word.');
  }

  read16(address: number): number {
    const region = this.region(address, 2);
    if (region.kind === 'ram') {
      return this.ram.read16(region.offset);
    }
    if (region.kind === 'rom') {
      return this.cartridgeView.getUint16(region.offset, false);
    }
    if (region.kind === 'pif') {
      return this.pifView.getUint16(region.offset, false);
    }
    if (region.kind === 'signal') {
      return this.signal.view.getUint16(region.offset, false);
    }
    throw new Vr4300Gap('device-access-width', 0, address, 'N64 device reads require a word.');
  }

  read32(address: number): number {
    const physical = this.physical(address, 4);
    if (physical + 4 <= this.ramView.byteLength) {
      return this.ramView.getUint32(physical, false);
    }
    const region = this.region(address, 4);
    if (region.kind === 'ram') {
      return this.ram.read32(region.offset);
    }
    if (region.kind === 'rom') {
      return this.cartridgeView.getUint32(region.offset, false);
    }
    if (region.kind === 'pif') {
      return this.pifView.getUint32(region.offset, false);
    }
    if (region.kind === 'signal') {
      return this.signal.view.getUint32(region.offset, false);
    }
    return this.readDevice(region.offset);
  }

  read64(address: number): bigint {
    this.physical(address, 8);
    return (BigInt(this.read32(address)) << 32n) | BigInt(this.read32((address + 4) >>> 0));
  }

  private writable(address: number, size: number) {
    const region = this.region(address, size);
    if (region.kind === 'rom') {
      throw new Vr4300Gap('read-only-memory', 0, address, 'The cartridge ROM is read-only.');
    }
    return region;
  }

  write8(address: number, value: number): void {
    const region = this.writable(address, 1);
    if (region.kind === 'ram') {
      this.ram.write8(region.offset, value);
    } else if (region.kind === 'pif') {
      this.pifView.setUint8(region.offset, value);
    } else if (region.kind === 'signal') {
      this.signal.view.setUint8(region.offset, value);
    } else {
      throw new Vr4300Gap('device-access-width', 0, address, 'N64 device writes require a word.');
    }
  }

  write16(address: number, value: number): void {
    const region = this.writable(address, 2);
    if (region.kind === 'ram') {
      this.ram.write16(region.offset, value);
    } else if (region.kind === 'pif') {
      this.pifView.setUint16(region.offset, value, false);
    } else if (region.kind === 'signal') {
      this.signal.view.setUint16(region.offset, value, false);
    } else {
      throw new Vr4300Gap('device-access-width', 0, address, 'N64 device writes require a word.');
    }
  }

  write32(address: number, value: number): void {
    const physical = this.physical(address, 4);
    if (physical + 4 <= this.ramView.byteLength) {
      this.ramView.setUint32(physical, value >>> 0, false);
      return;
    }
    const region = this.writable(address, 4);
    if (region.kind === 'ram') {
      this.ram.write32(region.offset, value);
    } else if (region.kind === 'pif') {
      this.pifView.setUint32(region.offset, value >>> 0, false);
    } else if (region.kind === 'signal') {
      this.signal.view.setUint32(region.offset, value >>> 0, false);
    } else {
      this.writeDevice(region.offset, value);
    }
  }

  write64(address: number, value: bigint): void {
    this.physical(address, 8);
    this.write32(address, Number(BigInt.asUintN(32, value >> 32n)));
    this.write32((address + 4) >>> 0, Number(BigInt.asUintN(32, value)));
  }

  snapshot() {
    this.beforeDeviceAccess?.();
    return {
      pif: [...this.pif],
      interrupts: this.interrupts.snapshot(),
      video: this.video.snapshot(),
      peripheral: this.peripheral.snapshot(),
      serial: this.serial.snapshot(),
      audio: this.audio.snapshot(),
      signal: this.signal.snapshot(),
      display: this.display.snapshot(),
      accesses: this.accesses.map((access) => ({ ...access })),
    };
  }
  /** RDRAM and SP memory bytes are restored separately from device state. */
  restore(state: ReturnType<N64Memory['snapshot']>): void {
    this.pif.set(state.pif);
    Object.assign(this.interrupts, state.interrupts);
    this.video.restore(state.video);
    this.peripheral.restore(state.peripheral);
    this.serial.restore(state.serial);
    this.audio.restore(state.audio);
    this.signal.restore(state.signal);
    this.display.restore(state.display);
    this.accesses.length = 0;
    for (const access of state.accesses) {
      this.accesses.push({ ...access });
    }
  }
}
