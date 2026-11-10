import { NesEnvelope } from './apu-envelope.js';

export const PAL_NOISE_PERIODS = [
  4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778,
] as const;
export const PAL_DMC_PERIODS = [
  398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50,
] as const;

/** The triangle DAC holds its last value when its counters stop the sequence;
 * disabling this channel does not replace that value with silence. */
export class NesTriangle {
  enabled = false;
  length = 0;
  control = 0;
  linear = 0;
  reload = false;
  period = 0;
  timer = 0;
  phase = 0;

  get output(): number {
    return this.phase < 16 ? 15 - this.phase : this.phase - 16;
  }
  tick(): void {
    if (this.timer) {
      this.timer--;
    } else {
      this.timer = this.period;
      if (this.length && this.linear) {
        this.phase = (this.phase + 1) & 31;
      }
    }
  }
  quarterFrame(): void {
    if (this.reload) {
      this.linear = this.control & 127;
    } else if (this.linear) {
      this.linear--;
    }
    if (!(this.control & 128)) {
      this.reload = false;
    }
  }
  halfFrame(): void {
    if (this.length && !(this.control & 128)) {
      this.length--;
    }
  }
  write(register: number, value: number, length: number): void {
    if (register === 0) {
      this.control = value;
    } else if (register === 2) {
      this.period = (this.period & 0x700) | value;
    } else if (register === 3) {
      this.period = (this.period & 255) | ((value & 7) << 8);
      if (this.enabled) {
        this.length = length;
      }
      this.reload = true;
    }
  }
  snapshot() {
    return {
      enabled: this.enabled,
      length: this.length,
      control: this.control,
      linear: this.linear,
      reload: this.reload,
      period: this.period,
      timer: this.timer,
      phase: this.phase,
    };
  }
}

/** Fifteen-bit shift register, with distinct long/short feedback taps. */
export class NesNoise {
  readonly envelope = new NesEnvelope();
  enabled = false;
  length = 0;
  control = 0;
  timer = 0;
  shift = 1;

  get output(): number {
    return this.length && !(this.shift & 1) ? this.envelope.volume : 0;
  }
  tick(): void {
    if (this.timer) {
      this.timer--;
    } else {
      this.timer = PAL_NOISE_PERIODS[this.control & 15]! - 1;
      const tap = this.control & 128 ? 6 : 1;
      const feedback = (this.shift ^ (this.shift >>> tap)) & 1;
      this.shift = (this.shift >>> 1) | (feedback << 14);
    }
  }
  halfFrame(): void {
    if (this.length && !(this.envelope.control & 32)) {
      this.length--;
    }
  }
  write(register: number, value: number, length: number): void {
    if (register === 0) {
      this.envelope.control = value;
    } else if (register === 2) {
      this.control = value;
    } else if (register === 3) {
      if (this.enabled) {
        this.length = length;
      }
      this.envelope.restart = true;
    }
  }
  snapshot() {
    return {
      enabled: this.enabled,
      length: this.length,
      control: this.control,
      timer: this.timer,
      shift: this.shift,
      envelope: this.envelope.snapshot(),
    };
  }
}

/** DMC separates cartridge reading from its bitstream output. DMA completion
 * can raise IRQ before the last buffered byte has finished sounding. */
export class NesDmc {
  control = 0;
  level = 0;
  sampleAddress = 0xc000;
  sampleLength = 1;
  address = 0xc000;
  remaining = 0;
  buffer: number | undefined;
  timer = 0;
  shift = 0;
  bits = 8;
  silent = true;
  irq = false;
  reads = 0;
  dmaReadyAt = 0;

  get dmaAddress(): number | undefined {
    return this.buffer === undefined && this.remaining ? this.address : undefined;
  }
  private restart(): void {
    this.address = this.sampleAddress;
    this.remaining = this.sampleLength;
  }
  enable(enabled: boolean, cycle = 0): void {
    this.irq = false;
    if (!enabled) {
      this.remaining = 0;
    } else if (!this.remaining) {
      this.restart();
      if (this.buffer === undefined) {
        this.dmaReadyAt = cycle + (cycle & 1 ? 4 : 3);
      }
    }
  }
  complete(value: number): void {
    if (this.dmaAddress === undefined) {
      throw new Error('DMC reader has no pending request.');
    }
    this.buffer = value & 255;
    this.address = this.address === 0xffff ? 0x8000 : this.address + 1;
    this.reads++;
    if (--this.remaining === 0) {
      if (this.control & 64) {
        this.restart();
      } else if (this.control & 128) {
        this.irq = true;
      }
    }
  }
  write(register: number, value: number): void {
    if (register === 0) {
      this.control = value;
      if (!(value & 128)) {
        this.irq = false;
      }
    } else if (register === 1) {
      this.level = value & 127;
    } else if (register === 2) {
      this.sampleAddress = 0xc000 + value * 64;
    } else {
      this.sampleLength = value * 16 + 1;
    }
  }
  tick(cycle = 0): void {
    if (this.timer) {
      this.timer--;
      return;
    }
    this.timer = PAL_DMC_PERIODS[this.control & 15]! - 1;
    if (!this.silent) {
      if (this.shift & 1) {
        if (this.level <= 125) {
          this.level += 2;
        }
      } else if (this.level >= 2) {
        this.level -= 2;
      }
    }
    this.shift >>>= 1;
    if (--this.bits === 0) {
      this.bits = 8;
      this.silent = this.buffer === undefined;
      if (this.buffer !== undefined) {
        this.shift = this.buffer;
        this.buffer = undefined;
        this.dmaReadyAt = cycle + 1;
      }
    }
  }
  snapshot() {
    return {
      control: this.control,
      level: this.level,
      sampleAddress: this.sampleAddress,
      sampleLength: this.sampleLength,
      address: this.address,
      remaining: this.remaining,
      buffer: this.buffer ?? null,
      timer: this.timer,
      shift: this.shift,
      bits: this.bits,
      silent: this.silent,
      irq: this.irq,
      reads: this.reads,
      dmaReadyAt: this.dmaReadyAt,
    };
  }
}
