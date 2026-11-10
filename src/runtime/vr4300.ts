import { Vr4300Control } from './vr4300-control.js';
import { Vr4300Fpu } from './vr4300-fpu.js';
import { Vr4300AddressSpace, type Vr4300MemoryFault } from './vr4300-memory.js';
import { registerWords, lowRegisterWord, highRegisterWord } from './register-words.js';

/** Architectural VR4300 state. The initial backend counts instructions, not
 * hardware pipeline/cache cycles. Device timing belongs to the N64 machine. */
export interface Vr4300Memory {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  read64(address: number): bigint;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  write64(address: number, value: bigint): void;
}

/** Compiler metadata is a hint only; the machine still guards the actual
 * source words and interrupt state before summarizing an idle loop. */
export interface Vr4300Program {
  step(machine: Vr4300Machine): void;
  idleAddresses?: ReadonlySet<number>;
}

export class Vr4300Gap extends Error {
  constructor(
    readonly kind: string,
    readonly pc: number,
    readonly address: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'Vr4300Gap';
  }
}

/** Internal control transfer after an architectural guest exception. It aborts
 * the faulting operation before its destination or delay pipeline is committed. */
export class Vr4300Exception extends Error {}

/** Contiguous big-endian RAM fixture with physical/KSEG aliases. This is used
 * for CPU checks; it is not the complete N64 memory or device map. */
export class Vr4300Ram implements Vr4300Memory {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size = 4 * 1024 * 1024, fill = 0) {
    this.bytes = new Uint8Array(size).fill(fill);
    this.view = new DataView(this.bytes.buffer);
  }
  private offset(address: number, size: number): number {
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff || address % size !== 0) {
      throw new Vr4300Gap('address-error', 0, address, 'Unaligned or invalid MIPS memory address.');
    }
    const physical = address >= 0x80000000 && address < 0xc0000000 ? address & 0x1fffffff : address;
    if (physical + size > this.bytes.length) {
      throw new Vr4300Gap('unmapped-memory', 0, address, 'Address is outside this RAM fixture.');
    }
    return physical;
  }
  read8(address: number): number {
    return this.view.getUint8(this.offset(address, 1));
  }
  read16(address: number): number {
    return this.view.getUint16(this.offset(address, 2), false);
  }
  read32(address: number): number {
    return this.view.getUint32(this.offset(address, 4), false);
  }
  read64(address: number): bigint {
    return this.view.getBigUint64(this.offset(address, 8), false);
  }
  write8(address: number, value: number): void {
    this.view.setUint8(this.offset(address, 1), value);
  }
  write16(address: number, value: number): void {
    this.view.setUint16(this.offset(address, 2), value, false);
  }
  write32(address: number, value: number): void {
    this.view.setUint32(this.offset(address, 4), value >>> 0, false);
  }
  write64(address: number, value: bigint): void {
    this.view.setBigUint64(this.offset(address, 8), BigInt.asUintN(64, value), false);
  }
}

export class Vr4300Machine {
  readonly bus: Vr4300Memory;
  readonly registers = new BigInt64Array(32);
  private readonly words = registerWords(this.registers);
  readonly control = new Vr4300Control((detail) => this.gap('system-control', detail));
  readonly fpu = new Vr4300Fpu(
    () => this.control.read(12),
    () =>
      this.raiseException(
        11,
        'coprocessor-unusable',
        'CP1 is disabled in the CPU status register.',
        1,
      ),
    (detail) => this.gap('fpu-register', detail),
    (detail) => this.raiseException(15, 'floating-point-exception', detail),
  );
  guestExceptions = false;
  get fcsr(): number {
    return this.fpu.control;
  }
  set fcsr(value: number) {
    this.fpu.control = value;
  }
  hi = 0n;
  lo = 0n;
  pc: number;
  nextPc: number;
  cycles = 0;
  instructions = 0;
  private delaySlot = false;
  private selectedPc = 0;
  private selectedNext = 0;
  private scheduledDelay = false;
  get inBranchDelaySlot(): boolean {
    return this.delaySlot;
  }
  constructor(
    physicalBus: Vr4300Memory,
    entry = 0,
    readonly virtualMemory = false,
  ) {
    // Small instruction fixtures may use a physical RAM bus directly. A real
    // N64 CPU always enables virtual addressing, even in kernel mode.
    this.bus = virtualMemory
      ? new Vr4300AddressSpace(
          physicalBus,
          this.control,
          (fault) => this.memoryException(fault),
          (detail) => this.gap('virtual-memory', detail),
        )
      : physicalBus;
    this.pc = entry >>> 0;
    this.nextPc = (entry + 4) >>> 0;
  }
  r(index: number): bigint {
    return index === 0 ? 0n : this.registers[index]!;
  }
  u(index: number): bigint {
    return BigInt.asUintN(64, this.r(index));
  }
  r32(index: number): number {
    return index === 0 ? 0 : this.words[index * 2 + lowRegisterWord]! | 0;
  }
  set32(index: number, value: number | bigint): void {
    if (index !== 0) {
      if (typeof value === 'number' && Number.isInteger(value)) {
        const word = value | 0,
          slot = index * 2;
        this.words[slot + lowRegisterWord] = word;
        this.words[slot + highRegisterWord] = word >> 31;
      } else {
        this.registers[index] = BigInt.asIntN(32, BigInt(value));
      }
    }
  }
  set64(index: number, value: bigint): void {
    if (index !== 0) {
      this.registers[index] = BigInt.asIntN(64, value);
    }
  }
  private setUnsigned32(index: number, value: number): void {
    if (index !== 0) {
      this.words[index * 2 + lowRegisterWord] = value;
      this.words[index * 2 + highRegisterWord] = 0;
    }
  }
  address(value: bigint): number {
    if (value !== BigInt.asIntN(32, value) && (value < 0n || value > 0xffffffffn)) {
      this.gap('address-width', 'This backend does not yet translate wider virtual addresses.');
    }
    return Number(BigInt.asUintN(32, value));
  }
  private effectiveAddress(base: number, offset: number): number {
    if (!Number.isInteger(offset) || offset < -32768 || offset > 32767) {
      return this.address(BigInt.asIntN(64, this.r(base) + BigInt(offset)));
    }
    const slot = base * 2,
      low = base === 0 ? 0 : this.words[slot + lowRegisterWord]!,
      high = base === 0 ? 0 : this.words[slot + highRegisterWord]! | 0,
      sum = low + offset,
      upper = high + (sum < 0 ? -1 : sum >= 0x100000000 ? 1 : 0),
      address = sum >>> 0;
    if (upper !== 0 && !(upper === -1 && address >= 0x80000000)) {
      this.gap('address-width', 'This backend does not yet translate wider virtual addresses.');
    }
    return address;
  }

  /** Dispatch can pass the word it just fetched in this instruction. Direct
   * callers still fetch here. Both paths guard the same original source word. */
  begin(address: number, word: number, fetchedWord?: number): void {
    if (this.pc !== address || (fetchedWord ?? this.bus.read32(address)) !== word) {
      this.gap('changed-instruction', 'The instruction does not match its compiled source word.');
    }
    this.selectedPc = this.nextPc;
    this.selectedNext = (this.nextPc + 4) >>> 0;
    this.scheduledDelay = false;
  }
  finish(): void {
    this.pc = this.selectedPc;
    this.nextPc = this.selectedNext;
    this.delaySlot = this.scheduledDelay;
    this.registers[0] = 0n;
    this.instructions++;
    this.cycles++; // Functional instruction count; not a VR4300 timing claim.
  }
  /** Exact summary of BEQ $0,$0,-1 + NOP. There are no register or memory
   * effects; only branch-delay phase and retired instruction counts change.
   * The caller must stop before any external event or accepted interrupt. */
  // A caller may reuse kernel-RDRAM words inspected in this synchronous
  // probe/advance. Permission, phase and word checks still happen here.
  canAdvanceIdleLoop(branchWord?: number, slotWord?: number): boolean {
    const base = this.delaySlot ? (this.pc - 4) >>> 0 : this.pc;
    if (this.virtualMemory) {
      const status = this.control.read(12);
      if (base < 0x80000000 || base >= 0xc0000000 || (!(status & 6) && (status & 0x18) !== 0)) {
        return false; // Never speculate a potentially faulting fetch.
      }
    }
    if (
      this.nextPc !== (this.delaySlot ? base : (base + 4) >>> 0) ||
      (branchWord ?? this.bus.read32(base)) !== 0x1000ffff ||
      (slotWord ?? this.bus.read32((base + 4) >>> 0)) !== 0
    ) {
      return false;
    }
    return true;
  }
  advanceIdleLoop(count: number, branchWord?: number, slotWord?: number): boolean {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !this.canAdvanceIdleLoop(branchWord, slotWord)
    ) {
      return false;
    }
    const base = this.delaySlot ? (this.pc - 4) >>> 0 : this.pc;
    const delayed = (Number(this.delaySlot) + count) % 2 === 1;
    this.pc = delayed ? (base + 4) >>> 0 : base;
    this.nextPc = delayed ? base : (base + 4) >>> 0;
    this.delaySlot = delayed;
    this.instructions += count;
    this.cycles += count;
    this.registers[0] = 0n;
    return true;
  }
  /** Play tier: instructions a faulting compiled block retired, including
   * the faulting one. Set only when a block rethrows. */
  blockTicks = 0;
  /** Play tier: a compiled block may start only at an ordinary boundary, in
   * kernel mode, where KSEG0/KSEG1 data accesses need no translation. */
  canEnterBlock(): boolean {
    if (this.delaySlot || this.nextPc !== (this.pc + 4) >>> 0) {
      return false;
    }
    const status = this.control.read(12);
    return (status & 6) !== 0 || (status & 0x18) === 0;
  }
  /** Play tier: the next block operation is a delay slot, so a fault records
   * the branch address and BD flag exactly as the reference path does. */
  blockSlot(pc: number): void {
    this.pc = pc;
    this.delaySlot = true;
  }
  /** Play tier: commit a compiled block's control transfer and counts. */
  endBlock(next: number, count: number): void {
    this.pc = next >>> 0;
    this.nextPc = (next + 4) >>> 0;
    this.delaySlot = false;
    this.instructions += count;
    this.cycles += count;
  }
  /** True when checkInterrupts would enter the handler now. No effects. */
  interruptPending(external: boolean): boolean {
    const status = this.control.read(12),
      cause = (this.control.read(13) & ~0x400) | (external ? 0x400 : 0);
    return (status & 7) === 1 && (status & cause & 0xff00) !== 0;
  }
  branch(taken: boolean, target: number, likely = false): void {
    if (this.delaySlot) {
      this.gap(
        'branch-in-delay-slot',
        'A branch in a branch delay slot is outside the defined execution contract.',
      );
    }
    if (taken) {
      this.selectedNext = target >>> 0;
      this.scheduledDelay = true;
    } else if (likely) {
      this.selectedPc = this.selectedNext;
      this.selectedNext = (this.selectedNext + 4) >>> 0;
    } else {
      this.scheduledDelay = true;
    }
  }
  returnFromException(): void {
    if (this.delaySlot) {
      this.gap('eret-in-delay-slot', 'ERET in a delay slot has no defined execution contract.');
    }
    const status = this.control.read(12);
    const error = (status & 4) !== 0;
    const target = this.control.read(error ? 30 : 14);
    this.control.write(12, status & ~(error ? 4 : 2));
    this.selectedPc = target;
    this.selectedNext = (target + 4) >>> 0;
    this.scheduledDelay = false;
  }
  checkInterrupts(external: boolean): boolean {
    const registers = this.control.registers;
    registers[13] = external ? registers[13]! | 0x400 : registers[13]! & ~0x400;
    const status = this.control.read(12),
      cause = this.control.read(13);
    if ((status & 7) !== 1 || (status & cause & 0xff00) === 0) {
      return false;
    }
    this.enterException(0);
    return true;
  }
  private enterException(code: number, coprocessor = 0, refill = false): void {
    const registers = this.control.registers;
    const status = this.control.read(12);
    let cause = (this.control.read(13) & ~0x3000007c) | (code << 2) | (coprocessor << 28);
    if ((status & 2) === 0) {
      registers[14] = this.delaySlot ? (this.pc - 4) >>> 0 : this.pc;
      cause = (cause & ~0x80000000) | (this.delaySlot ? 0x80000000 : 0);
    }
    registers[13] = cause >>> 0;
    registers[12] = status | 2;
    this.pc = (status & 0x400000) !== 0 ? 0xbfc00200 : 0x80000000;
    if (!refill || status & 2) {
      this.pc += 0x180;
    }
    this.nextPc = (this.pc + 4) >>> 0;
    this.delaySlot = false;
  }
  raiseException(code: number, kind: string, detail: string, coprocessor = 0): never {
    if (!this.guestExceptions) {
      this.gap(kind, detail);
    }
    this.enterException(code, coprocessor);
    throw new Vr4300Exception(detail);
  }
  private memoryException(fault: Vr4300MemoryFault): never {
    const { kind, address, write } = fault;
    if (!this.guestExceptions) {
      throw new Vr4300Gap(
        `memory-${kind}`,
        this.pc,
        address,
        `CPU ${write ? 'write' : 'read'} address translation failed.`,
      );
    }
    const registers = this.control.registers;
    registers[8] = address;
    if (kind !== 'address') {
      registers[4] = (registers[4]! & 0xff800000) | ((address >>> 9) & 0x7ffff0);
      registers[10] = (address & 0xffffe000) | (registers[10]! & 255);
      // Low word of XContext: R[0], BadVPN2[26:0], zero[3:0]. The
      // current control model stores 32-bit words; extended virtual addresses
      // remain outside its declared execution contract.
      registers[20] = Number((BigInt.asUintN(64, BigInt(address | 0)) >> 9n) & 0xfffffff0n);
    }
    const code = kind === 'address' ? (write ? 5 : 4) : kind === 'modification' ? 1 : write ? 3 : 2;
    this.enterException(code, 0, kind === 'miss');
    throw new Vr4300Exception(`CPU ${kind} memory exception at $${address.toString(16)}.`);
  }
  add32(destination: number, a: number, b: number, trap: boolean): void {
    const sum = a + b;
    if (trap && (sum < -0x80000000 || sum > 0x7fffffff)) {
      this.raiseException(12, 'integer-overflow', 'Signed 32-bit addition overflow.');
    }
    this.set32(destination, sum);
  }
  add64(destination: number, a: bigint, b: bigint, trap: boolean): void {
    const sum = a + b;
    if (trap && sum !== BigInt.asIntN(64, sum)) {
      this.raiseException(12, 'integer-overflow', 'Signed 64-bit addition overflow.');
    }
    this.set64(destination, sum);
  }
  multiply(left: number, right: number, width: 32 | 64, signed: boolean): void {
    const operand = (index: number) =>
      signed ? BigInt.asIntN(width, this.r(index)) : BigInt.asUintN(width, this.r(index));
    const product = operand(left) * operand(right);
    this.lo = BigInt.asIntN(width, product);
    this.hi = BigInt.asIntN(width, product >> BigInt(width));
  }
  divide(left: number, right: number, width: 32 | 64, signed: boolean): void {
    const operand = (index: number) =>
      signed ? BigInt.asIntN(width, this.r(index)) : BigInt.asUintN(width, this.r(index));
    const dividend = operand(left),
      divisor = operand(right);
    if (divisor === 0n) {
      this.gap(
        'undefined-division',
        'Division by zero has no architectural result in this backend.',
      );
    }
    this.lo = BigInt.asIntN(width, dividend / divisor);
    this.hi = BigInt.asIntN(width, dividend % divisor);
  }
  readFpuControl(destination: number, index: number): void {
    this.requireFpu();
    if (index !== 0 && index !== 31) {
      this.gap('fpu-control', `FPU control register ${index} is not implemented.`);
    }
    this.set32(destination, index === 0 ? 0xa00 : this.fcsr);
  }
  writeFpuControl(source: number, index: number): void {
    this.requireFpu();
    if (index !== 31) {
      this.gap('fpu-control', `Writing FPU control register ${index} is not implemented.`);
    }
    const value = this.r32(source) >>> 0;
    this.fcsr = value & 0x0183ffff;
    // An enabled pending exception must enter the guest exception handler; the
    // initial backend stops explicitly until that path is implemented.
    if ((value & 0x20000) !== 0 || ((value >>> 12) & (value >>> 7) & 31) !== 0) {
      this.raiseException(
        15,
        'floating-point-exception',
        'CTC1 enables a pending floating-point exception.',
      );
    }
  }
  private requireFpu(): void {
    if ((this.control.read(12) & 0x20000000) === 0) {
      this.raiseException(
        11,
        'coprocessor-unusable',
        'CP1 is disabled in the CPU status register.',
        1,
      );
    }
  }
  fpuMemory(register: number, base: number, offset: number, wide: boolean, store: boolean): void {
    this.requireFpu();
    const address = this.effectiveAddress(base, offset);
    if (store) {
      if (wide) {
        this.bus.write64(address, this.fpu.doubleword(register));
      } else {
        this.bus.write32(address, this.fpu.word(register));
      }
    } else if (wide) {
      this.fpu.setDoubleword(register, this.bus.read64(address));
    } else {
      this.fpu.setWord(register, this.bus.read32(address));
    }
  }
  cache(operation: number, base: number, offset: number): void {
    // The functional backend has one coherent memory view. A supported cache
    // maintenance instruction affects no data here; no cache-hit timing claim.
    this.effectiveAddress(base, offset);
    if (![0, 1, 8, 9, 13, 16, 17, 21, 25].includes(operation)) {
      this.gap('cache-operation', `Cache operation ${operation} is not implemented.`);
    }
  }
  load(destination: number, base: number, offset: number, size: number, signed: boolean): void {
    const address = this.effectiveAddress(base, offset);
    if (size === 1 || size === 2 || size === 4) {
      const value =
        size === 1
          ? this.bus.read8(address)
          : size === 2
            ? this.bus.read16(address)
            : this.bus.read32(address);
      if (signed) {
        const shift = 32 - size * 8;
        this.set32(destination, (value << shift) >> shift);
      } else {
        this.setUnsigned32(destination, value);
      }
      return;
    }
    const value =
      size === 1
        ? BigInt(this.bus.read8(address))
        : size === 2
          ? BigInt(this.bus.read16(address))
          : size === 4
            ? BigInt(this.bus.read32(address))
            : this.bus.read64(address);
    this.set64(destination, signed ? BigInt.asIntN(size * 8, value) : value);
  }
  store(source: number, base: number, offset: number, size: number): void {
    const address = this.effectiveAddress(base, offset);
    if (size === 1) {
      this.bus.write8(address, this.r32(source) & 255);
    } else if (size === 2) {
      this.bus.write16(address, this.r32(source) & 65535);
    } else if (size === 4) {
      this.bus.write32(address, this.r32(source) >>> 0);
    } else {
      this.bus.write64(address, this.u(source));
    }
  }
  /** Big-endian left/right transfers touch only the addressed portion of an
   * aligned word. Paired instructions can reconstruct an unaligned value;
   * each instruction also has defined partial-register/memory behavior. */
  mergeMemory(
    register: number,
    base: number,
    offset: number,
    width: 4 | 8,
    left: boolean,
    store: boolean,
  ): void {
    const address = this.effectiveAddress(base, offset);
    const withinWord = address & (width - 1),
      count = left ? width - withinWord : withinWord + 1,
      memory = left ? address : address - withinWord,
      firstRegisterByte = left ? 0 : width - count;
    let value = BigInt.asUintN(width * 8, this.r(register));
    for (let byte = 0; byte < count; byte++) {
      const shift = BigInt((width - firstRegisterByte - byte - 1) * 8);
      if (store) {
        this.bus.write8(memory + byte, Number((value >> shift) & 255n));
      } else {
        value = (value & ~(255n << shift)) | (BigInt(this.bus.read8(memory + byte)) << shift);
      }
    }
    if (!store) {
      this.set64(register, BigInt.asIntN(width * 8, value));
    }
  }
  gap(kind: string, detail: string): never {
    throw new Vr4300Gap(kind, this.pc, this.pc, detail);
  }
  snapshot() {
    const hex = (value: bigint) => BigInt.asUintN(64, value).toString(16).padStart(16, '0');
    return {
      pc: this.pc,
      nextPc: this.nextPc,
      delaySlot: this.delaySlot,
      registers: Array.from(this.registers, hex),
      hi: hex(this.hi),
      lo: hex(this.lo),
      control: this.control.snapshot(),
      fcsr: this.fcsr,
      fpu: this.fpu.snapshot(),
      cycles: this.cycles,
      instructions: this.instructions,
    };
  }
  restore(state: ReturnType<Vr4300Machine['snapshot']>): void {
    this.pc = state.pc;
    this.nextPc = state.nextPc;
    this.delaySlot = state.delaySlot;
    this.registers.set(state.registers.map((value) => BigInt.asIntN(64, BigInt('0x' + value))));
    this.registers[0] = 0n;
    this.hi = BigInt.asIntN(64, BigInt('0x' + state.hi));
    this.lo = BigInt.asIntN(64, BigInt('0x' + state.lo));
    this.control.restore(state.control);
    this.fpu.restore(state.fpu);
    this.fcsr = state.fcsr;
    this.cycles = state.cycles;
    this.instructions = state.instructions;
  }
}
