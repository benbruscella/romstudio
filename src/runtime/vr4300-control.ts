/** VR4300 system-control state. Cache timing and asynchronous interrupts are
 * supplied by the machine backend; these registers do not invent elapsed time. */
export class Vr4300Control {
  readonly registers = new Uint32Array(32);
  readonly tlb: (Vr4300TlbEntry | undefined)[] = Array.from({ length: 32 });
  private halfCycle = 0;

  constructor(private readonly unsupported: (detail: string) => never) {
    this.registers[1] = 31; // Random starts at the last TLB entry.
    this.registers[15] = 0xb22; // VR4300 implementation and revision.
  }

  read(index: number): number {
    if (
      ![
        0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 26, 27, 28, 29, 30,
      ].includes(index)
    ) {
      this.unsupported(`CP0 register ${index} is not implemented.`);
    }
    return this.registers[index]!;
  }

  write(index: number, value: number): void {
    const word = value >>> 0;
    switch (index) {
      case 0: // Index: probe failure bit and five-bit entry index.
        this.registers[index] = word & 0x8000003f;
        break;
      case 2:
      case 3: // EntryLo0 / EntryLo1: PFN, cache attributes, dirty, valid, global.
        this.registers[index] = word & 0x3fffffff;
        break;
      case 5:
        this.registers[index] = word & 0x01ffe000;
        break;
      case 6: // Wired also resets Random.
        this.registers[index] = word & 63;
        this.registers[1] = 31;
        break;
      case 9:
      case 10:
      case 12:
      case 14:
      case 16:
      case 18:
      case 19:
      case 20:
      case 26:
      case 28:
      case 29:
      case 30:
        this.registers[index] = word;
        break;
      case 11: // Compare acknowledges the timer interrupt.
        this.registers[index] = word;
        this.registers[13] = this.registers[13]! & ~0x8000;
        break;
      case 13: // Only the software interrupt pending bits are writable.
        this.registers[index] = (this.registers[index]! & ~0x300) | (word & 0x300);
        break;
      case 1:
      case 8:
      case 15:
      case 27: // Read-only registers ignore writes.
        break;
      default:
        this.unsupported(`Writing CP0 register ${index} is not implemented.`);
    }
  }

  writeTlb(random = false): void {
    const index = this.registers[random ? 1 : 0]! & 63;
    if (index >= 32) {
      this.unsupported(`TLB index ${index} is outside the VR4300's 32 entries.`);
    }
    const pageMask = this.registers[5]!;
    const global = (this.registers[2]! & this.registers[3]! & 1) !== 0;
    this.tlb[index] = {
      pageMask,
      entryHi: (this.registers[10]! & ~pageMask) >>> 0,
      entryLo0: ((this.registers[2]! & ~1) | Number(global)) >>> 0,
      entryLo1: ((this.registers[3]! & ~1) | Number(global)) >>> 0,
    };
  }

  readTlb(): void {
    const index = this.registers[0]! & 63;
    const entry = this.tlb[index];
    if (!entry) {
      this.unsupported(`TLB entry ${index} has no initialized value in this fixture.`);
    }
    this.registers[5] = entry.pageMask;
    this.registers[10] = entry.entryHi;
    this.registers[2] = entry.entryLo0;
    this.registers[3] = entry.entryLo1;
  }

  probeTlb(): void {
    const lookup = this.registers[10]!;
    const index = this.tlb.findIndex((entry) => {
      if (!entry) {
        return false;
      }
      const vpnMask = ~(entry.pageMask | 0x1fff);
      const sameAddress = ((entry.entryHi ^ lookup) & vpnMask) === 0;
      const global = (entry.entryLo0 & entry.entryLo1 & 1) !== 0;
      return sameAddress && (global || ((entry.entryHi ^ lookup) & 255) === 0);
    });
    this.registers[0] = index < 0 ? 0x80000000 : index;
  }

  advance(cpuCycles: number): void {
    const total = this.halfCycle + cpuCycles;
    const counts = Math.floor(total / 2);
    this.halfCycle = total % 2;
    const previous = this.registers[9]!;
    this.registers[9] = previous + counts;
    const untilCompare = (this.registers[11]! - previous) >>> 0;
    if (untilCompare > 0 && untilCompare <= counts) {
      this.registers[13] = this.registers[13]! | 0x8000;
    }
    const wired = this.registers[6]!;
    if (wired < 32) {
      const range = 32 - wired;
      const next = this.registers[1]! - cpuCycles;
      this.registers[1] = wired + ((((next - wired) % range) + range) % range);
    }
  }
  ticksUntilCompare(): number {
    const difference = (this.registers[11]! - this.registers[9]!) >>> 0;
    return difference ? difference * 2 - this.halfCycle : Infinity;
  }

  snapshot() {
    return {
      registers: [...this.registers],
      halfCycle: this.halfCycle,
      tlb: this.tlb.map((entry) => (entry ? { ...entry } : null)),
    };
  }
  restore(state: ReturnType<Vr4300Control['snapshot']>): void {
    this.registers.set(state.registers);
    this.halfCycle = state.halfCycle;
    state.tlb.forEach((entry, index) => {
      this.tlb[index] = entry ? { ...entry } : undefined;
    });
  }
}

export interface Vr4300TlbEntry {
  pageMask: number;
  entryHi: number;
  entryLo0: number;
  entryLo1: number;
}
