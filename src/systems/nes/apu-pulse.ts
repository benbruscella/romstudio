import { NesEnvelope } from './apu-envelope.js';

// Time order after the high-timer write resets the waveform sequencer.
const duties = [0b01000000, 0b01100000, 0b01111000, 0b10011111];

/** One pulse channel. The timer clocks at CPU/2; envelope and sweep clocks
 * come from the APU frame divider, independently of PPU video frames. */
export class NesPulse {
  readonly envelope = new NesEnvelope();
  enabled = false;
  length = 0;
  period = 0;
  timer = 0;
  phase = 0;
  sweep = 0;
  sweepDivider = 0;
  sweepReload = false;

  constructor(private readonly first: boolean) {}

  get target(): number {
    const change = this.period >>> (this.sweep & 7);
    return Math.max(0, this.period + (this.sweep & 8 ? -change - Number(this.first) : change));
  }
  get muted(): boolean {
    return this.period < 8 || this.target > 2047;
  }
  get output(): number {
    return this.length &&
      !this.muted &&
      (duties[this.envelope.control >>> 6]! >>> (7 - this.phase)) & 1
      ? this.envelope.volume
      : 0;
  }
  tick(): void {
    if (this.timer) {
      this.timer--;
    } else {
      this.timer = this.period;
      this.phase = (this.phase + 1) & 7;
    }
  }
  halfFrame(): void {
    if (this.length && !(this.envelope.control & 32)) {
      this.length--;
    }
    if (!this.sweepDivider && this.sweep & 128 && this.sweep & 7 && !this.muted) {
      this.period = this.target;
    }
    if (!this.sweepDivider || this.sweepReload) {
      this.sweepDivider = (this.sweep >>> 4) & 7;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }
  write(register: number, value: number, length: number): void {
    if (register === 0) {
      this.envelope.control = value;
    } else if (register === 1) {
      this.sweep = value;
      this.sweepReload = true;
    } else if (register === 2) {
      this.period = (this.period & 0x700) | value;
    } else {
      this.period = (this.period & 255) | ((value & 7) << 8);
      if (this.enabled) {
        this.length = length;
      }
      this.phase = 0;
      this.envelope.restart = true;
    }
  }
  snapshot() {
    return {
      enabled: this.enabled,
      length: this.length,
      period: this.period,
      timer: this.timer,
      phase: this.phase,
      sweep: this.sweep,
      sweepDivider: this.sweepDivider,
      sweepReload: this.sweepReload,
      envelope: this.envelope.snapshot(),
    };
  }
}
