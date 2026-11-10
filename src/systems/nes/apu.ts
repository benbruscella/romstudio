import { NesPulse } from './apu-pulse.js';
import { NesTriangle, NesNoise, NesDmc } from './apu-channels.js';
import { NesApuFrame } from './apu-frame.js';

export const NES_LENGTHS = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192,
  24, 72, 26, 16, 28, 32, 30,
] as const;

// Exact evaluation of the documented nonlinear DAC approximation, cached for
// the finite channel levels. This is synthesis, not an audio recording.
const pulseMix = Float64Array.from({ length: 31 }, (_, n) => (n ? 95.88 / (8128 / n + 100) : 0));
const tndMix = Float64Array.from({ length: 32768 }, (_, n) => {
  const input = (n >>> 11) / 8227 + ((n >>> 7) & 15) / 12241 + (n & 127) / 22638;
  return input ? 159.79 / (1 / input + 100) : 0;
});

/** PAL Ricoh 2A07 audio hardware. CPU register writes are the sole source of
 * music and effects. Chip clocks run even when browser output is muted.
 * See NESdev's APU, frame-counter, pulse, triangle, noise and DMC research. */
export class NesApu {
  readonly registers = new Uint8Array(24);
  readonly pulses = [new NesPulse(true), new NesPulse(false)] as const;
  readonly triangle = new NesTriangle();
  readonly noise = new NesNoise();
  readonly dmc = new NesDmc();
  readonly frame = new NesApuFrame();
  cycle = 0;
  writes = 0;
  onClock: (() => void) | undefined;
  onWrite: ((address: number, value: number, cycle: number) => void) | undefined;

  get irq(): boolean {
    return this.frame.irq || this.dmc.irq;
  }

  write(address: number, value: number): void {
    if (address < 0x4000 || address > 0x4017 || address === 0x4014 || address === 0x4016) {
      throw new Error('Invalid APU register address.');
    }
    value &= 255;
    this.registers[address - 0x4000] = value;
    this.writes++;
    this.onWrite?.(address, value, this.cycle);
    const length = NES_LENGTHS[value >>> 3]!;
    if (address < 0x4008) {
      this.pulses[(address >>> 2) & 1]!.write(address & 3, value, length);
    } else if (address < 0x400c) {
      this.triangle.write(address & 3, value, length);
    } else if (address < 0x4010) {
      this.noise.write(address & 3, value, length);
    } else if (address < 0x4014) {
      this.dmc.write(address & 3, value);
    } else if (address === 0x4015) {
      for (const [index, channel] of [...this.pulses, this.triangle, this.noise].entries()) {
        channel.enabled = !!(value & (1 << index));
        if (!channel.enabled) {
          channel.length = 0;
        }
      }
      this.dmc.enable(!!(value & 16), this.cycle);
    } else if (address === 0x4017) {
      this.frame.write(value, this.cycle);
    }
  }
  readStatus(): number {
    const value =
      Number(this.pulses[0].length > 0) |
      (Number(this.pulses[1].length > 0) << 1) |
      (Number(this.triangle.length > 0) << 2) |
      (Number(this.noise.length > 0) << 3) |
      (Number(this.dmc.remaining > 0) << 4) |
      (Number(this.frame.irq) << 6) |
      (Number(this.dmc.irq) << 7);
    this.frame.irq = false;
    return value;
  }
  private readonly quarter = (): void => {
    this.pulses[0].envelope.clock();
    this.pulses[1].envelope.clock();
    this.noise.envelope.clock();
    this.triangle.quarterFrame();
  };
  private readonly half = (): void => {
    this.pulses[0].halfFrame();
    this.pulses[1].halfFrame();
    this.triangle.halfFrame();
    this.noise.halfFrame();
  };
  advanceTo(cycle: number): void {
    if (!Number.isSafeInteger(cycle) || cycle < this.cycle) {
      throw new Error('APU clock cannot move backwards.');
    }
    while (this.cycle < cycle) {
      this.cycle++;
      this.frame.tick(this.cycle, this.quarter, this.half);
      if (!(this.cycle & 1)) {
        this.pulses[0].tick();
        this.pulses[1].tick();
      }
      this.triangle.tick();
      this.noise.tick();
      this.dmc.tick(this.cycle);
      this.onClock?.();
    }
  }
  mix(): number {
    return (
      pulseMix[this.pulses[0].output + this.pulses[1].output]! +
      tndMix[(this.triangle.output << 11) | (this.noise.output << 7) | this.dmc.level]!
    );
  }
  snapshot() {
    return {
      cycle: this.cycle,
      registers: [...this.registers],
      writes: this.writes,
      pulses: this.pulses.map((channel) => channel.snapshot()),
      triangle: this.triangle.snapshot(),
      noise: this.noise.snapshot(),
      dmc: this.dmc.snapshot(),
      frame: this.frame.snapshot(),
    };
  }
}
