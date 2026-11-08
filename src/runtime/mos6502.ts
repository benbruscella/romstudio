// This module is shared unchanged by headless tests and exported browser builds.
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
  peek(address: number): number;
  /** Optional system clock: return cycles spent waiting for a read-ready bus. */
  cpuCycle?: ((cycle: number, write: boolean, opcodeFetch?: boolean) => number) | undefined;
  /** Ricoh 2A03/2A07 retain D but perform binary ADC/SBC. NMOS defaults true. */
  decimalArithmetic?: boolean;
}
export class ExecutionGap extends Error {
  constructor(
    readonly kind: string,
    readonly address: number,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionGap';
  }
}
export interface CpuState {
  a: number;
  x: number;
  y: number;
  sp: number;
  p: number;
  pc: number;
  cycles: number;
  instructions: number;
}
export class Machine implements CpuState {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  p = 0x24;
  pc = 0;
  cycles = 0;
  instructions = 0;
  constructor(readonly bus: Bus) {}
  private clocked = false;
  private access = 0;
  private waits = 0;
  beginInstruction(): void {
    this.clocked = !!this.bus.cpuCycle;
    this.access = 0;
    this.waits = 0;
    this.clock(false, true); // SYNC/opcode fetch; the byte guard already checked it.
  }
  private clock(write: boolean, opcodeFetch = false): void {
    if (!this.clocked) {
      return;
    }
    this.waits += this.bus.cpuCycle!(this.cycles + this.access + this.waits, write, opcodeFetch);
    this.access++;
  }
  idle(cycles: number): void {
    if (this.clocked) {
      for (let cycle = 0; cycle < cycles; cycle++) {
        this.clock(false);
      }
    }
  }
  finishInstruction(cycles: number): void {
    if (this.clocked && this.access > cycles) {
      throw new Error(`CPU bus sequence exceeds instruction timing at $${this.pc.toString(16)}.`);
    }
    this.idle(cycles - this.access);
    this.cycles += cycles + this.waits;
    this.clocked = false;
  }
  flag(mask: number, set: boolean): void {
    this.p = ((set ? this.p | mask : this.p & ~mask) | 0x20) & 0xef;
  }
  nz(value: number): number {
    const byte = value & 255;
    this.flag(2, byte === 0);
    this.flag(128, !!(byte & 128));
    return byte;
  }
  read(address: number): number {
    this.clock(false);
    return this.bus.read(address & 65535) & 255;
  }
  write(address: number, value: number): void {
    this.clock(true);
    this.bus.write(address & 65535, value & 255);
  }
  word(address: number): number {
    return this.read(address) | (this.read(address + 1) << 8);
  }
  zpWord(address: number): number {
    return this.read(address & 255) | (this.read((address + 1) & 255) << 8);
  }
  push(value: number): void {
    this.write(0x100 | this.sp, value);
    this.sp = (this.sp - 1) & 255;
  }
  pop(): number {
    this.sp = (this.sp + 1) & 255;
    return this.read(0x100 | this.sp);
  }
  compare(register: number, value: number): void {
    this.flag(1, register >= value);
    this.nz(register - value);
  }
  adc(value: number): void {
    const a = this.a,
      carry = this.p & 1,
      sum = a + value + carry,
      result = sum & 255;
    if (this.p & 8 && this.bus.decimalArithmetic !== false) {
      // NMOS: Z comes from binary addition; N/V include the low-digit carry
      // but precede the high-digit correction. The carry between digits is
      // one bit even for invalid BCD inputs. See docs/CPU-DECIMAL.md.
      let low = (a & 15) + (value & 15) + carry;
      if (low > 9) {
        low += 6;
      }
      let decimal = (a & 240) + (value & 240) + (low & 15) + (low > 15 ? 16 : 0);
      this.flag(2, result === 0);
      this.flag(128, !!(decimal & 128));
      this.flag(64, !!(~(a ^ value) & (a ^ decimal) & 128));
      if (decimal > 0x9f) {
        decimal += 0x60;
      }
      this.flag(1, decimal > 255);
      this.a = decimal & 255;
      return;
    }
    this.flag(1, sum > 255);
    this.flag(64, !!(~(a ^ value) & (a ^ result) & 128));
    this.a = this.nz(result);
  }
  sbc(value: number): void {
    const a = this.a,
      borrow = 1 - (this.p & 1),
      difference = a - value - borrow,
      result = difference & 255;
    if (this.p & 8 && this.bus.decimalArithmetic !== false) {
      // NMOS subtraction retains the binary flags and corrects the digits.
      let low = (a & 15) - (value & 15) - borrow;
      if (low < 0) {
        low = ((low - 6) & 15) - 16;
      }
      let decimal = (a & 240) - (value & 240) + low;
      if (decimal < 0) {
        decimal -= 0x60;
      }
      this.flag(1, difference >= 0);
      this.flag(64, !!((a ^ value) & (a ^ result) & 128));
      this.nz(result);
      this.a = decimal & 255;
      return;
    }
    this.flag(1, difference >= 0);
    this.flag(64, !!((a ^ value) & (a ^ result) & 128));
    this.a = this.nz(result);
  }
  guard(address: number, expected: number[]): void {
    for (let i = 0; i < expected.length; i++) {
      if (this.bus.peek((address + i) & 65535) !== expected[i]) {
        this.gap('stale-code', 'Mapped instruction bytes changed; lift a new memory epoch.');
      }
    }
  }
  gap(kind: string, message: string): never {
    throw new ExecutionGap(kind, this.pc, message);
  }
  snapshot(): CpuState {
    return {
      a: this.a,
      x: this.x,
      y: this.y,
      sp: this.sp,
      p: this.p,
      pc: this.pc,
      cycles: this.cycles,
      instructions: this.instructions,
    };
  }
}
export class RamBus implements Bus {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array = new Uint8Array(65536)) {
    if (bytes.length !== 65536) {
      throw new Error('RAM bus needs 64 KiB.');
    }
    this.bytes = bytes.slice();
  }
  read(address: number): number {
    return this.bytes[address & 65535]!;
  }
  write(address: number, value: number): void {
    this.bytes[address & 65535] = value & 255;
  }
  peek(address: number): number {
    return this.bytes[address & 65535]!;
  }
}
