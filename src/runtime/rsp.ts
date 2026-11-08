import { RspVector } from './rsp-vector.js';

/** RSP scalar architecture: 32-bit registers, separate 4 KiB instruction/data
 * memories and branch delay slots. Vector state is supplied separately. */
export interface RspBus {
  /** Optional pure, live 4 KiB DMEM view; byte callbacks have no side effects.
   * Buses that observe individual transfers must omit this fast path. */
  readonly data?: DataView;
  instruction(address: number): number;
  readByte(address: number): number;
  writeByte(address: number, value: number): void;
  readControl(index: number): number;
  writeControl(index: number, value: number): void;
  break(): void;
}

/** A preflighted span of nontrapping registers/private-DMEM work. The system may
 * execute it together only when no CPU/device event can observe its interior. */
export interface RspLinearBlock {
  instructions: number;
  execute(): void;
}
export interface RspProgram {
  step(machine: RspMachine): void;
  prepareLinear?(machine: RspMachine, limit: number): RspLinearBlock | undefined;
  /** Execute bounded original local operations. The caller excludes CPU/device
   * observations inside. stableReads additionally promises that SP status/DMA
   * and DPC current/status reads cannot change before the event deadline.
   * pureFetch additionally excludes instruction-fetch side effects and IMEM
   * mutation, permitting whole guarded status-poll iterations to coalesce.
   * Writes, semaphore reads, BREAK and faulting operations remain barriers. */
  runLocal?(machine: RspMachine, limit: number, stableReads?: boolean, pureFetch?: boolean): number;
}

export class RspGap extends Error {
  constructor(
    readonly kind: string,
    readonly pc: number,
    readonly word: number,
    message: string,
  ) {
    super(message);
    this.name = 'RspGap';
  }
}

export class RspMachine {
  readonly registers = new Int32Array(32);
  readonly vector = new RspVector((detail) => this.gap('vector-operation', detail));
  pc = 0;
  nextPc = 4;
  instructions = 0;
  /** Host observations only, excluded from architectural checkpoints. */
  readonly executionStats = { controlWaitInstructions: 0 };
  private delaySlot = false;
  private selectedPc = 0;
  private selectedNext = 0;
  private scheduledDelay = false;

  get inBranchDelaySlot(): boolean {
    return this.delaySlot;
  }

  constructor(readonly bus: RspBus) {}

  r(index: number): number {
    return index === 0 ? 0 : this.registers[index]!;
  }
  u(index: number): number {
    return this.r(index) >>> 0;
  }
  set(index: number, value: number): void {
    if (index !== 0) {
      this.registers[index] = value | 0;
    }
  }

  enter(address: number): void {
    this.pc = address & 0xffc;
    this.nextPc = (this.pc + 4) & 0xfff;
    this.delaySlot = false;
  }

  begin(address: number, word: number, fetchedWord?: number): void {
    if (this.pc !== address || (fetchedWord ?? this.bus.instruction(address)) !== word) {
      this.gap('changed-instruction', 'The RSP instruction differs from its compiled source word.');
    }
    this.selectedPc = this.nextPc;
    this.selectedNext = (this.nextPc + 4) & 0xfff;
    this.scheduledDelay = false;
  }

  finish(): void {
    this.pc = this.selectedPc;
    this.nextPc = this.selectedNext;
    this.delaySlot = this.scheduledDelay;
    this.registers[0] = 0;
    this.instructions++;
  }

  /** A whole MFC0/conditional-branch/NOP wait loop returns to the same PC.
   * The caller guards all three words and the stable control-read value, and
   * excludes device/CPU observations until the strict event deadline. */
  advanceControlWait(instructions: number): void {
    if (
      !Number.isInteger(instructions) ||
      instructions < 3 ||
      instructions > 255 ||
      instructions % 3 ||
      this.delaySlot ||
      this.nextPc !== ((this.pc + 4) & 4095)
    ) {
      throw new Error('A control wait requires complete guarded three-instruction loops.');
    }
    this.instructions += instructions;
    this.registers[0] = 0;
    this.executionStats.controlWaitInstructions += instructions;
  }

  branch(taken: boolean, target: number): void {
    if (this.delaySlot) {
      this.gap(
        'branch-in-delay-slot',
        'RSP branches in delay slots are outside this execution contract.',
      );
    }
    if (taken) {
      this.selectedNext = target & 0xffc;
    }
    this.scheduledDelay = true;
  }

  load(destination: number, base: number, offset: number, size: number, signed: boolean): void {
    const address = (this.r(base) + offset) & 0xfff;
    let value = 0;
    for (let byte = 0; byte < size; byte++) {
      value = (value << 8) | this.bus.readByte((address + byte) & 0xfff);
    }
    if (signed && size < 4) {
      value = (value << (32 - size * 8)) >> (32 - size * 8);
    }
    this.set(destination, value);
  }

  store(source: number, base: number, offset: number, size: number): void {
    const address = (this.r(base) + offset) & 0xfff,
      value = this.u(source);
    for (let byte = 0; byte < size; byte++) {
      this.bus.writeByte((address + byte) & 0xfff, (value >>> ((size - byte - 1) * 8)) & 255);
    }
  }

  /** The compiler resolves straight/quad/rest transfer shape once. Big-endian
   * halfword pairs preserve partial vector bytes and 4 KiB DMEM wrapping.
   * vectorMemory() remains the byte-wise reference and observable-bus path. */
  transferVector(
    operation: string,
    store: boolean,
    register: number,
    base: number,
    offset: number,
    element: number,
    size: number,
  ): void {
    const data = this.bus.data;
    if (!data || (size < 0 && element !== 0)) {
      this.vectorMemory(operation, register, base, offset, element);
      return;
    }
    const address = (this.r(base) + offset) & 4095;
    const count =
      size > 0
        ? store
          ? size
          : Math.min(size, 16 - element)
        : size === 0
          ? store
            ? 16 - (address & 15)
            : Math.min(16 - element, 16 - (address & 15))
          : address & 15;
    const first = size < 0 ? 16 - count : element,
      memory = size < 0 ? address & ~15 : address,
      lanes = this.vector.registers,
      laneBase = register * 8;
    for (let byte = 0; byte < count;) {
      const at = (memory + byte) & 4095,
        selected = (first + byte) & 15;
      if (!(selected & 1) && byte + 1 < count && at < 4095) {
        if (store) {
          data.setUint16(at, lanes[laneBase + (selected >>> 1)]!, false);
        } else {
          lanes[laneBase + (selected >>> 1)] = data.getUint16(at, false);
        }
        byte += 2;
      } else {
        if (store) {
          data.setUint8(at, this.vector.byte(register, selected));
        } else {
          this.vector.setByte(register, selected, data.getUint8(at));
        }
        byte++;
      }
    }
  }

  vectorMemory(
    operation: string,
    register: number,
    base: number,
    offset: number,
    element: number,
  ): void {
    const address = (this.r(base) + offset) & 0xfff,
      store = operation.startsWith('S');
    const kind = operation.slice(1),
      sizes: Record<string, number> = { BV: 1, SV: 2, LV: 4, DV: 8 };
    if (kind === 'TV') {
      // Transpose transfers touch one lane in each register of an eight-register
      // group. VT's low bits are ignored. Stores rotate bytes within a 16-byte
      // window rooted at an eight-byte boundary; loads have different alignment
      // and element rules. See the physical-console vector load/store tests.
      const group = register & ~7,
        window = address & ~7;
      if (store) {
        for (let byte = 0; byte < 16; byte++) {
          const source = group + (((byte >>> 1) + (element >>> 1)) & 7);
          this.bus.writeByte(
            (window + (((address & 7) + byte) & 15)) & 4095,
            this.vector.byte(source, byte),
          );
        }
      } else {
        for (let lane = 0; lane < 8; lane++) {
          const target = group + (((element >>> 1) + lane) & 7);
          for (let byte = 0; byte < 2; byte++) {
            const offset = ((address & 8) + element + lane * 2 + byte) & 15;
            this.vector.setByte(
              target,
              lane * 2 + byte,
              this.bus.readByte((window + offset) & 4095),
            );
          }
        }
      }
      return;
    }
    if (kind === 'PV' || kind === 'UV') {
      if (element !== 0 || (address & 7) !== 0) {
        this.gap(
          'vector-memory-element',
          'Packed loads currently require byte element zero and an eight-byte-aligned DMEM address.',
        );
      }
      // Packed vertex colors become eight fixed-point lanes. LUV leaves a
      // zero sign bit (bits 14:7); LPV places the byte in bits 15:8.
      for (let lane = 0; lane < 8; lane++) {
        if (store) {
          this.bus.writeByte(
            (address + lane) & 4095,
            (this.vector.lane(register, lane) >>> (kind === 'PV' ? 8 : 7)) & 255,
          );
        } else {
          this.vector.setLane(
            register,
            lane,
            this.bus.readByte((address + lane) & 4095) << (kind === 'PV' ? 8 : 7),
          );
        }
      }
      return;
    }
    let count: number,
      first = element,
      memory = address;
    if (sizes[kind]) {
      count = store ? sizes[kind]! : Math.min(sizes[kind]!, 16 - element);
    } else if (kind === 'QV') {
      count = store ? 16 - (address & 15) : Math.min(16 - element, 16 - (address & 15));
    } else if (kind === 'RV') {
      if (element !== 0) {
        this.gap('vector-memory-element', 'Nonzero LRV/SRV byte elements are not implemented yet.');
      }
      count = address & 15;
      first = 16 - count;
      memory = address & ~15;
    } else {
      this.gap('vector-memory', `Vector memory operation ${operation} is not implemented.`);
    }
    for (let byte = 0; byte < count; byte++) {
      if (store) {
        this.bus.writeByte(
          (memory + byte) & 0xfff,
          this.vector.byte(register, (first + byte) & 15),
        );
      } else {
        this.vector.setByte(register, first + byte, this.bus.readByte((memory + byte) & 0xfff));
      }
    }
  }

  gap(kind: string, message: string): never {
    throw new RspGap(kind, this.pc, this.bus.instruction(this.pc), message);
  }

  snapshot() {
    return {
      pc: this.pc,
      nextPc: this.nextPc,
      delaySlot: this.delaySlot,
      registers: [...this.registers],
      instructions: this.instructions,
      vector: this.vector.snapshot(),
    };
  }

  restore(state: ReturnType<RspMachine['snapshot']>): void {
    this.pc = state.pc;
    this.nextPc = state.nextPc;
    this.delaySlot = state.delaySlot;
    this.registers.set(state.registers);
    this.registers[0] = 0;
    this.instructions = state.instructions;
    this.vector.restore(state.vector);
  }
}
