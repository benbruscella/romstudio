import type { Vr4300Memory } from './vr4300.js';
import type { Vr4300Control } from './vr4300-control.js';

export interface Vr4300MemoryFault {
  kind: 'address' | 'miss' | 'invalid' | 'modification';
  address: number;
  write: boolean;
}

/** CPU virtual addresses and device/DMA physical addresses are different
 * domains. This adapter applies the CPU's 32-bit address-space rules before
 * reaching the physical bus. It never translates RSP or device DMA accesses.
 * NEC VR4300 manual, chapters 5 and 6.4.7–8. */
export class Vr4300AddressSpace implements Vr4300Memory {
  constructor(
    private readonly physical: Vr4300Memory,
    private readonly control: Vr4300Control,
    private readonly fault: (fault: Vr4300MemoryFault) => never,
    private readonly unsupported: (detail: string) => never,
  ) {}

  private translate(address: number, size: number, write: boolean): number {
    const fail = (kind: Vr4300MemoryFault['kind']): never => this.fault({ kind, address, write });
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff || address % size) {
      return fail('address');
    }
    const status = this.control.read(12);
    const mode = status & 6 ? 0 : (status >>> 3) & 3; // EXL/ERL force kernel mode.
    if (mode === 3) {
      return this.unsupported('Reserved KSU mode has no defined address-space contract.');
    }
    if (address >= 0x80000000) {
      const supervisor = address >= 0xc0000000 && address < 0xe0000000;
      if (mode === 2 || (mode === 1 && !supervisor)) {
        return fail('address');
      }
      if (address < 0xc0000000) {
        return address & 0x1fffffff; // KSEG0 and KSEG1 bypass the TLB.
      }
    } else if (status & 4) {
      return address; // ERL makes the low user region unmapped and uncached.
    }
    const asid = this.control.read(10) & 255;
    let match: { low: number; pageBytes: number } | undefined;
    for (const entry of this.control.tlb) {
      if (!entry || ((entry.entryHi ^ address) & ~(entry.pageMask | 0x1fff)) !== 0) {
        continue;
      }
      if (!(entry.entryLo0 & entry.entryLo1 & 1) && (entry.entryHi & 255) !== asid) {
        continue;
      }
      if (![0, 0x6000, 0x1e000, 0x7e000, 0x1fe000, 0x7fe000, 0x1ffe000].includes(entry.pageMask)) {
        return this.unsupported('The TLB entry has an unsupported page-mask encoding.');
      }
      if (match) {
        return this.unsupported('Multiple matching TLB entries have undefined lookup behavior.');
      }
      const pageBytes = ((entry.pageMask | 0x1fff) + 1) / 2;
      match = { pageBytes, low: address & pageBytes ? entry.entryLo1 : entry.entryLo0 };
    }
    if (!match) {
      return fail('miss');
    }
    if (!(match.low & 2)) {
      return fail('invalid');
    }
    if (write && !(match.low & 4)) {
      return fail('modification');
    }
    const frame = (match.low >>> 6) * 4096;
    if (frame > 0xffffffff) {
      return this.unsupported('This CPU backend requires a 32-bit physical page frame.');
    }
    return ((frame & ~(match.pageBytes - 1)) | (address & (match.pageBytes - 1))) >>> 0;
  }

  read8(address: number): number {
    return this.physical.read8(this.translate(address, 1, false));
  }
  read16(address: number): number {
    return this.physical.read16(this.translate(address, 2, false));
  }
  read32(address: number): number {
    return this.physical.read32(this.translate(address, 4, false));
  }
  read64(address: number): bigint {
    return this.physical.read64(this.translate(address, 8, false));
  }
  write8(address: number, value: number): void {
    this.physical.write8(this.translate(address, 1, true), value);
  }
  write16(address: number, value: number): void {
    this.physical.write16(this.translate(address, 2, true), value);
  }
  write32(address: number, value: number): void {
    this.physical.write32(this.translate(address, 4, true), value);
  }
  write64(address: number, value: bigint): void {
    this.physical.write64(this.translate(address, 8, true), value);
  }
}
