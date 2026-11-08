/** Video Interface registers. Scanout and the scanline clock are separate from
 * the RDP that draws into RDRAM; a framebuffer alone is not a rendered game. */
export class N64Video {
  readonly registers = new Uint32Array(14);
  currentHalfLine = 0;
  fields = 0;
  private phase = 0;

  constructor(private readonly interrupt: () => void) {}

  read(offset: number): number {
    return offset === 0x10 ? this.currentHalfLine : this.registers[offset >>> 2]!;
  }

  write(offset: number, word: number): boolean {
    if (offset === 0x10) {
      return true; // Any write acknowledges the VI interrupt.
    }
    const masks = [
      0x1ffff, 0xffffff, 0xfff, 0x3ff, 0, 0x3fffffff, 0x3ff, 0x1fffff, 0x0fff0fff, 0x03ff03ff,
      0x03ff03ff, 0x03ff03ff, 0x0fff0fff, 0x0fff0fff,
    ];
    this.registers[offset >>> 2] = word & masks[offset >>> 2]!;
    return false;
  }

  /** PAL scanline clock driven by the machine's declared functional CPU ticks.
   * Register divisors are real VI units; instruction/cache costs remain an
   * approximation in the initial CPU backend. */
  advance(cpuTicks: number): void {
    const horizontal = (this.registers[7]! & 0xfff) + 1;
    const vertical = this.registers[6]! & 0x3ff;
    if (horizontal <= 1 || vertical === 0) {
      return;
    }
    this.phase += cpuTicks * 49656530 * 2;
    const period = horizontal * 93750000;
    while (this.phase >= period) {
      this.phase -= period;
      this.currentHalfLine++;
      if (this.currentHalfLine >= vertical) {
        this.currentHalfLine = 0;
        this.fields++;
      }
      if (this.currentHalfLine === (this.registers[3]! & 0x3ff)) {
        this.interrupt();
      }
    }
  }

  snapshot() {
    return {
      registers: [...this.registers],
      currentHalfLine: this.currentHalfLine,
      fields: this.fields,
      phase: this.phase,
    };
  }
  ticksUntilInterrupt(): number {
    const horizontal = (this.registers[7]! & 0xfff) + 1,
      vertical = this.registers[6]! & 0x3ff,
      target = this.registers[3]! & 0x3ff;
    if (horizontal <= 1 || vertical === 0 || target >= vertical) {
      return Infinity;
    }
    const lines = (target - this.currentHalfLine + vertical) % vertical || vertical;
    return Math.ceil((lines * horizontal * 93750000 - this.phase) / (49656530 * 2));
  }
  restore(state: ReturnType<N64Video['snapshot']>): void {
    this.registers.set(state.registers);
    this.currentHalfLine = state.currentHalfLine;
    this.fields = state.fields;
    this.phase = state.phase;
  }
}
