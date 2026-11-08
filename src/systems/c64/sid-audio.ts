/** Original SID register writes drive this small, independent sound model.
 * Frequency/waveform/ADSR controls follow the MOS datasheet. Analogue filter
 * response, combined-waveform behaviour and envelope quirks are approximate.
 * This output device never supplies invented oscillator reads to the CPU. */
export const PAL_SID_CLOCK = 985248;
const PHASE = 0x1000000;
const ATTACK = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
const RELEASE = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];
interface Voice {
  phase: number;
  noise: number;
  envelope: number;
  stage: 'attack' | 'decay' | 'release';
  gate: boolean;
}
export class SidAudio {
  readonly registers: Uint8Array;
  private readonly voices: Voice[];
  private cycle: number;
  private nextSample: number;
  private samples: number[] = [];
  private low = 0;
  private band = 0;
  private lastInput = 0;
  private highPass = 0;
  constructor(
    registers: Uint8Array,
    cycle: number,
    readonly sampleRate = 44100,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
      throw new Error('Invalid SID sample rate.');
    }
    this.registers = registers.slice();
    this.cycle = cycle;
    this.nextSample = cycle + PAL_SID_CLOCK / sampleRate;
    this.voices = Array.from({ length: 3 }, (_, voice) => ({
      phase: 0,
      noise: 0x7fffff,
      envelope: 0,
      stage: 'attack',
      gate: !!(registers[voice * 7 + 4]! & 1),
    }));
  }
  write(register: number, value: number, cycle: number): void {
    this.advanceTo(cycle);
    register &= 31;
    value &= 255;
    if (register < 21 && register % 7 === 4) {
      const voice = this.voices[Math.floor(register / 7)]!,
        gate = !!(value & 1);
      if (gate !== voice.gate) {
        voice.gate = gate;
        voice.stage = gate ? 'attack' : 'release';
      }
      if (value & 8) {
        voice.phase = 0;
        voice.noise = 0x7fffff;
      }
    }
    this.registers[register] = value;
  }
  advanceTo(cycle: number): void {
    if (cycle < this.cycle || !Number.isFinite(cycle)) {
      throw new Error('SID audio clock cannot run backwards.');
    }
    while (this.nextSample <= cycle) {
      this.advanceVoices(this.nextSample - this.cycle);
      this.cycle = this.nextSample;
      this.samples.push(this.mix());
      this.nextSample += PAL_SID_CLOCK / this.sampleRate;
    }
    this.advanceVoices(cycle - this.cycle);
    this.cycle = cycle;
  }
  take(): Float32Array {
    const samples = Float32Array.from(this.samples);
    this.samples = [];
    return samples;
  }
  private advanceVoices(cycles: number): void {
    const crossed: boolean[] = [];
    for (let index = 0; index < 3; index++) {
      const voice = this.voices[index]!,
        base = index * 7,
        r = this.registers,
        control = r[base + 4]!;
      const frequency = r[base]! | (r[base + 1]! << 8),
        before = voice.phase;
      const after = control & 8 ? 0 : before + frequency * cycles;
      crossed[index] =
        !(control & 8) &&
        Math.floor(after / 0x800000) > Math.floor(before / 0x800000) &&
        (Math.floor(after / 0x800000) & 1) === 1;
      // Noise shifts on rising bit 19. Samples are frequent enough that a
      // legal 16-bit frequency cannot cross more than two such edges here.
      const edges =
        control & 8
          ? 0
          : Math.floor((after + 0x80000) / 0x100000) - Math.floor((before + 0x80000) / 0x100000);
      for (let edge = 0; edge < edges; edge++) {
        voice.noise =
          ((voice.noise << 1) | (((voice.noise >>> 22) ^ (voice.noise >>> 17)) & 1)) & 0x7fffff;
      }
      voice.phase = after % PHASE;
      const milliseconds = cycles / 1000;
      if (!voice.gate) {
        voice.stage = 'release';
      }
      if (voice.stage === 'attack') {
        voice.envelope = Math.min(1, voice.envelope + milliseconds / ATTACK[r[base + 5]! >>> 4]!);
        if (voice.envelope === 1) {
          voice.stage = 'decay';
        }
      } else {
        const sustain = voice.stage === 'release' ? 0 : (r[base + 6]! >>> 4) / 15;
        const rate = voice.stage === 'release' ? r[base + 6]! & 15 : r[base + 5]! & 15;
        if (voice.envelope > sustain) {
          voice.envelope = Math.max(
            sustain,
            voice.envelope * Math.exp((-milliseconds * 5) / RELEASE[rate]!),
          );
        }
        if (voice.envelope < 1 / 65536) {
          voice.envelope = 0;
        }
      }
    }
    for (let index = 0; index < 3; index++) {
      if (this.registers[index * 7 + 4]! & 2 && crossed[(index + 2) % 3]) {
        this.voices[index]!.phase = 0;
      }
    }
  }
  private waveform(index: number): number {
    const voice = this.voices[index]!,
      base = index * 7,
      r = this.registers,
      control = r[base + 4]!;
    if (!(control & 0xf0) || control & 8) {
      return 0;
    }
    const phase = Math.floor(voice.phase),
      modulator = this.voices[(index + 2) % 3]!;
    let wave = 4095;
    if (control & 16) {
      const top = (phase >>> 23) ^ (control & 4 ? Math.floor(modulator.phase) >>> 23 : 0);
      wave &= ((top ? ~phase : phase) >>> 11) & 4095;
    }
    if (control & 32) {
      wave &= phase >>> 12;
    }
    if (control & 64) {
      wave &= phase >>> 12 >= (r[base + 2]! | ((r[base + 3]! & 15) << 8)) ? 4095 : 0;
    }
    if (control & 128) {
      const n = voice.noise;
      wave &=
        ((((n >>> 22) & 1) << 7) |
          (((n >>> 20) & 1) << 6) |
          (((n >>> 16) & 1) << 5) |
          (((n >>> 13) & 1) << 4) |
          (((n >>> 11) & 1) << 3) |
          (((n >>> 7) & 1) << 2) |
          (((n >>> 4) & 1) << 1) |
          ((n >>> 2) & 1)) <<
        4;
    }
    return (wave / 2047.5 - 1) * voice.envelope;
  }
  private mix(): number {
    const r = this.registers,
      route = r[23]!,
      mode = r[24]!;
    let dry = 0,
      input = 0;
    for (let voice = 0; voice < 3; voice++) {
      const value = this.waveform(voice);
      if (route & (1 << voice)) {
        input += value;
      } else if (voice !== 2 || !(mode & 128)) {
        dry += value;
      }
    }
    const cutoff = (r[21]! & 7) | (r[22]! << 3);
    const frequency = 30 + (cutoff / 2047) * 12000;
    const coefficient = Math.min(0.8, 2 * Math.sin((Math.PI * frequency) / this.sampleRate));
    const high = input - this.low - (1.4 - ((route >>> 4) / 15) * 1.1) * this.band;
    this.band += coefficient * high;
    this.low += coefficient * this.band;
    let filtered = 0;
    if (mode & 16) {
      filtered += this.low;
    }
    if (mode & 32) {
      filtered += this.band;
    }
    if (mode & 64) {
      filtered += high;
    }
    const output = (((dry + filtered) * (mode & 15)) / 15) * 0.2;
    // Remove the output's DC component, including extreme pulse widths.
    this.highPass = output - this.lastInput + 0.995 * this.highPass;
    this.lastInput = output;
    return Math.max(-1, Math.min(1, this.highPass));
  }
}
