/** PAL 2A07 frame divider, in CPU cycles (APU clock = CPU/2).
 * Four-step: Q, QH, Q, then three IRQ edges around the final QH.
 * Five-step: Q, QH, Q, idle, QH; no frame IRQ.
 * Reference: NESdev APU Frame Counter. Reset phase is an explicit cold fixture. */
export class NesApuFrame {
  cycle = 0;
  fiveStep = false;
  inhibit = false;
  irq = false;
  resetAt = -1;
  quarterClocks = 0;
  halfClocks = 0;

  write(value: number, cpuCycle: number): void {
    this.fiveStep = !!(value & 128);
    this.inhibit = !!(value & 64);
    if (this.inhibit) {
      this.irq = false;
    }
    this.resetAt = cpuCycle + (cpuCycle & 1 ? 4 : 3);
  }
  tick(cpuCycle: number, quarter: () => void, half: () => void): void {
    let quarterClock: boolean, halfClock: boolean;
    if (cpuCycle === this.resetAt) {
      this.resetAt = -1;
      this.cycle = 0;
      quarterClock = halfClock = this.fiveStep;
    } else {
      this.cycle++;
      quarterClock = this.cycle === 8313 || this.cycle === 16627 || this.cycle === 24939;
      halfClock = this.cycle === 16627;
      if (this.fiveStep) {
        if (this.cycle === 41565) {
          quarterClock = halfClock = true;
        }
        if (this.cycle === 41566) {
          this.cycle = 0;
        }
      } else {
        if (this.cycle >= 33252 && this.cycle <= 33254 && !this.inhibit) {
          this.irq = true;
        }
        if (this.cycle === 33253) {
          quarterClock = halfClock = true;
        }
        if (this.cycle === 33254) {
          this.cycle = 0;
        }
      }
    }
    if (quarterClock) {
      this.quarterClocks++;
      quarter();
    }
    if (halfClock) {
      this.halfClocks++;
      half();
    }
  }
  snapshot() {
    return {
      cycle: this.cycle,
      fiveStep: this.fiveStep,
      inhibit: this.inhibit,
      irq: this.irq,
      resetAt: this.resetAt,
      quarterClocks: this.quarterClocks,
      halfClocks: this.halfClocks,
    };
  }
}
