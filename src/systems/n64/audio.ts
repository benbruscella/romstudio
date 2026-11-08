import { Vr4300Gap } from '../../runtime/vr4300.js';

/** Two-entry AI FIFO and stereo signed-16-bit PCM consumption. Audio samples
 * come from guest RDRAM; the RSP that synthesizes them is a separate device. */
export class N64Audio {
  readonly registers = new Uint32Array(6);
  private readonly queue: { address: number; length: number; cursor: number }[] = [];
  private readonly ramView: DataView;
  private phase = 0;
  frames = 0;
  sampleHash = 0x811c9dc5;
  output: ((left: number, right: number, sampleRate: number) => void) | undefined;

  constructor(
    ram: Uint8Array,
    private readonly interrupt: (asserted: boolean) => void,
  ) {
    this.ramView = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  }

  read(offset: number): number {
    if (offset === 0x0c) {
      return (
        ((this.queue.length ? 0x40000000 : 0) | (this.queue.length === 2 ? 0x80000000 : 0)) >>> 0
      );
    }
    if (offset === 4) {
      const active = this.queue[0];
      return active ? (active.length - active.cursor) & ~7 : 0;
    }
    return this.registers[offset >>> 2]!;
  }

  write(offset: number, value: number): void {
    if (offset === 0x0c) {
      this.interrupt(false);
      return;
    }
    this.registers[offset >>> 2] = value & [0xfffff8, 0x3fff8, 1, 0, 0x3fff, 15][offset >>> 2]!;
    if (offset === 4 && this.registers[1] !== 0) {
      const address = this.registers[0]!,
        length = this.registers[1]!;
      if (this.queue.length === 2 || address + length > this.ramView.byteLength) {
        throw new Vr4300Gap('ai-fifo', 0, address, 'AI FIFO is full or its buffer exceeds RDRAM.');
      }
      this.queue.push({ address, length, cursor: 0 });
    }
  }

  advance(cpuTicks: number): void {
    if (!this.queue.length || (this.registers[2]! & 1) === 0) {
      return;
    }
    const divisor = this.registers[4]! + 1;
    const period = divisor * 93750000;
    this.phase += cpuTicks * 49656530;
    while (this.phase >= period && this.queue.length) {
      this.phase -= period;
      const active = this.queue[0]!;

      const left = this.ramView.getInt16(active.address + active.cursor, false);
      const right = this.ramView.getInt16(active.address + active.cursor + 2, false);
      active.cursor += 4;
      this.frames++;
      this.sampleHash = Math.imul((this.sampleHash ^ (left & 65535)) >>> 0, 16777619) >>> 0;
      this.sampleHash = Math.imul((this.sampleHash ^ (right & 65535)) >>> 0, 16777619) >>> 0;
      this.output?.(left / 32768, right / 32768, 49656530 / divisor);
      if (active.cursor === active.length) {
        this.queue.shift();
        this.interrupt(true);
      }
    }
    if (!this.queue.length) {
      this.phase = 0;
    }
  }

  snapshot() {
    return {
      registers: [...this.registers],
      queue: this.queue.map((entry) => ({ ...entry })),
      phase: this.phase,
      frames: this.frames,
      sampleHash: this.sampleHash,
    };
  }
  ticksUntilEvent(): number {
    return this.queue.length && this.registers[2]! & 1
      ? Math.ceil(((this.registers[4]! + 1) * 93750000 - this.phase) / 49656530)
      : Infinity;
  }
  restore(state: ReturnType<N64Audio['snapshot']>): void {
    this.registers.set(state.registers);
    this.queue.splice(0, this.queue.length, ...state.queue.map((entry) => ({ ...entry })));
    this.phase = state.phase;
    this.frames = state.frames;
    this.sampleHash = state.sampleHash;
  }
}
