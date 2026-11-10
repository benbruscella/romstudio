import { Vr4300Gap } from '../../runtime/vr4300.js';

/** A recovery stop retains the exact CPU status command for a later RSP study. */
export class N64SignalStart extends Vr4300Gap {
  constructor(
    pc: number,
    readonly command: number,
  ) {
    super('rsp-execution', 0, 0x04001000 + pc, 'The original program is starting RSP microcode.');
  }
}

/** CPU-facing Signal Processor registers and DMA. Execution is injected by the
 * machine; recovery can deliberately stop before clearing HALT. */
export class N64Signal {
  readonly memory = new Uint8Array(8192); // DMEM then IMEM, 4 KiB each.
  readonly view = new DataView(this.memory.buffer);
  memoryAddress = 0;
  dramAddress = 0;
  status = 1; // HALT
  pc = 0;
  semaphore = 0;
  onStart: (() => void) | undefined;
  starts = 0;
  breaks = 0;
  private readonly queue: {
    memory: number;
    dram: number;
    length: number;
    count: number;
    skip: number;
    write: boolean;
    remaining: number;
  }[] = [];
  readonly transfers: {
    memory: number;
    dram: number;
    length: number;
    count: number;
    skip: number;
    write: boolean;
  }[] = [];

  constructor(
    private readonly ram: Uint8Array,
    private readonly interrupt: (asserted: boolean) => void,
  ) {}

  read(offset: number): number {
    switch (offset) {
      case 0:
        return this.memoryAddress;
      case 4:
        return this.dramAddress;
      case 0x10:
        return this.status | (this.queue.length ? 4 : 0) | (this.queue.length === 2 ? 8 : 0);
      case 0x14:
        return Number(this.queue.length === 2);
      case 0x18:
        return Number(this.queue.length !== 0);
      case 0x1c: {
        const old = this.semaphore;
        this.semaphore = 1;
        return old;
      }
      default:
        throw new Vr4300Gap(
          'sp-register',
          0,
          0x04040000 + offset,
          'SP register read is not implemented.',
        );
    }
  }

  write(offset: number, word: number): void {
    if (offset === 0) {
      this.memoryAddress = word & 0x1ff8;
      return;
    }
    if (offset === 4) {
      this.dramAddress = word & 0xfffff8;
      return;
    }
    if (offset === 0x1c) {
      this.semaphore = 0;
      return;
    }
    if (offset === 0x10) {
      const wasHalted = (this.status & 1) !== 0;
      if ((word & 1) !== 0) {
        if (!this.onStart) {
          throw new N64SignalStart(this.pc, word);
        }
        this.status &= ~1;
      }
      if ((word & 2) !== 0) {
        this.status |= 1;
      }
      if ((word & 4) !== 0) {
        this.status &= ~2;
      }
      if ((word & 8) !== 0) {
        this.interrupt(false);
      }
      if ((word & 16) !== 0) {
        this.interrupt(true);
      }
      for (const [clear, set, flag] of [
        [0x20, 0x40, 0x20],
        [0x80, 0x100, 0x40],
      ]) {
        if ((word & clear!) !== 0) {
          this.status &= ~flag!;
        }
        if ((word & set!) !== 0) {
          this.status |= flag!;
        }
      }
      for (let signal = 0; signal < 8; signal++) {
        if ((word & (0x200 << (signal * 2))) !== 0) {
          this.status &= ~(0x80 << signal);
        }
        if ((word & (0x400 << (signal * 2))) !== 0) {
          this.status |= 0x80 << signal;
        }
      }
      if ((word & 1) !== 0 && wasHalted && (this.status & 1) === 0) {
        this.starts++;
        this.onStart?.();
      }
      return;
    }
    if (offset !== 8 && offset !== 12) {
      throw new Vr4300Gap(
        'sp-register',
        0,
        0x04040000 + offset,
        'SP register write is not implemented.',
      );
    }
    const length = ((word & 0xfff) | 7) + 1,
      count = ((word >>> 12) & 255) + 1,
      skip = word >>> 20;
    if (
      this.queue.length === 2 ||
      this.dramAddress + count * length + (count - 1) * skip > this.ram.length
    ) {
      throw new Vr4300Gap(
        'sp-dma',
        0,
        this.dramAddress,
        'SP DMA queue is full or the transfer exceeds RDRAM.',
      );
    }
    this.queue.push({
      memory: this.memoryAddress,
      dram: this.dramAddress,
      length,
      count,
      skip,
      write: offset === 12,
      remaining: 8 + (length * count) / 8,
    });
  }

  break(): void {
    this.status |= 3;
    this.breaks++;
    if ((this.status & 0x40) !== 0) {
      this.interrupt(true);
    }
  }

  advance(ticks: number): void {
    const active = this.queue[0];
    if (!active) {
      return;
    }
    active.remaining -= ticks;
    if (active.remaining > 0) {
      return;
    }
    const bank = active.memory & 0x1000;
    let memory = active.memory & 0xfff,
      dram = active.dram;
    for (let row = 0; row < active.count; row++) {
      for (let offset = 0; offset < active.length; offset++) {
        const address = bank | ((memory + offset) & 0xfff);
        if (active.write) {
          this.ram[dram + offset] = this.memory[address]!;
        } else {
          this.memory[address] = this.ram[dram + offset]!;
        }
      }
      memory = (memory + active.length) & 0xfff;
      dram += active.length + active.skip;
    }
    this.memoryAddress = bank | memory;
    this.dramAddress = dram;
    this.transfers.push({
      memory: active.memory,
      dram: active.dram,
      length: active.length,
      count: active.count,
      skip: active.skip,
      write: active.write,
    });
    this.queue.shift();
  }

  snapshot() {
    return {
      memoryAddress: this.memoryAddress,
      dramAddress: this.dramAddress,
      status: this.status,
      pc: this.pc,
      semaphore: this.semaphore,
      starts: this.starts,
      breaks: this.breaks,
      queue: this.queue.map((transfer) => ({ ...transfer })),
      transfers: this.transfers.map((transfer) => ({ ...transfer })),
    };
  }
  ticksUntilEvent(): number {
    return this.queue[0]?.remaining ?? Infinity;
  }

  restore(state: ReturnType<N64Signal['snapshot']>): void {
    this.memoryAddress = state.memoryAddress;
    this.dramAddress = state.dramAddress;
    this.status = state.status;
    this.pc = state.pc;
    this.semaphore = state.semaphore;
    this.starts = state.starts;
    this.breaks = state.breaks;
    this.queue.splice(0, this.queue.length, ...state.queue.map((transfer) => ({ ...transfer })));
    this.transfers.length = 0;
    for (const transfer of state.transfers) {
      this.transfers.push({ ...transfer });
    }
  }
}
