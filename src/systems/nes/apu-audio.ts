import type { NesApu } from './apu.js';
import { NES_PAL_CPU_HZ } from './timing.js';

/** Host-rate output is separate from the chip's digital state and IRQs.
 * Average the mixed DAC over each sample window, then approximate the NES
 * analogue high-pass/high-pass/low-pass stages. No replacement tunes exist. */
export class NesAudio {
  private samples: number[] = [];
  private phase = 0;
  private sum = 0;
  private count = 0;
  private previous: number;
  private high90 = 0;
  private previous90 = 0;
  private high440 = 0;
  private low = 0;
  private readonly r90: number;
  private readonly r440: number;
  private readonly lowCoefficient: number;
  constructor(
    readonly apu: NesApu,
    readonly sampleRate: number,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
      throw new Error('Invalid NES sample rate.');
    }
    this.previous = apu.mix();
    this.r90 = Math.exp((-2 * Math.PI * 90) / sampleRate);
    this.r440 = Math.exp((-2 * Math.PI * 440) / sampleRate);
    this.lowCoefficient = 1 - Math.exp((-2 * Math.PI * 14000) / sampleRate);
  }
  tick = (): void => {
    this.sum += this.apu.mix();
    this.count++;
    this.phase += this.sampleRate;
    if (this.phase < NES_PAL_CPU_HZ) {
      return;
    }
    this.phase -= NES_PAL_CPU_HZ;
    const raw = this.sum / this.count;
    this.sum = this.count = 0;
    this.high90 = this.r90 * (this.high90 + raw - this.previous);
    this.previous = raw;
    this.high440 = this.r440 * (this.high440 + this.high90 - this.previous90);
    this.previous90 = this.high90;
    this.low += this.lowCoefficient * (this.high440 - this.low);
    this.samples.push(Math.max(-1, Math.min(1, this.low * 2)));
  };
  take(): Float32Array {
    const samples = Float32Array.from(this.samples);
    this.samples = [];
    return samples;
  }
}
