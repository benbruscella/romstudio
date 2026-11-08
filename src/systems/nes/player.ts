import { Diagnostic } from '../../contracts.js';
import { Machine } from '../../runtime/mos6502.js';
import { FrameClock, type RecoveryGap } from '../../runtime/frame.js';
import { NesSystemBus, NES_PAL_FRAME_CYCLES, type NesLaunch } from './system.js';
import { NesAudio } from './apu-audio.js';

export interface NesControls {
  buttons: number;
}
export interface RecordedNesControls extends NesControls {
  frame: number;
}
/** NES input is sampled at the original $4016 strobe. Rendering and NMI timing
 * belong to the machine, while the same frame clock also paces C64 execution. */
export class NesPlayer {
  readonly bus: NesSystemBus;
  readonly machine: Machine;
  readonly display;
  readonly inputs: RecordedNesControls[] = [];
  controlFrames = 0;
  outcome: undefined;
  gap: RecoveryGap | undefined;
  private lastInput = -1;
  private readonly clock: FrameClock;
  private audio: NesAudio | undefined;
  constructor(
    launch: NesLaunch,
    readonly step: (machine: Machine) => void,
    input: (frame: number, player: NesPlayer) => NesControls,
    captureDisplay = true,
  ) {
    this.bus = new NesSystemBus(launch, captureDisplay);
    this.machine = new Machine(this.bus);
    this.display = this.bus.ppu;
    this.machine.pc = this.bus.peek(0xfffc) | (this.bus.peek(0xfffd) << 8);
    this.machine.cycles = 7;
    this.bus.advanceTo(7);
    this.clock = new FrameClock(7);
    this.bus.onControllerLatch = () => {
      const next = input(++this.controlFrames, this).buttons;
      if (!Number.isInteger(next) || next < 0 || next > 255) {
        throw new Diagnostic('NES_INPUT', 'Controller state must be an eight-bit value.');
      }
      this.bus.pad1 = next;
      if (next !== this.lastInput) {
        this.inputs.push({ frame: this.controlFrames, buttons: next });
      }
      this.lastInput = next;
    };
  }
  boundary(): boolean {
    return this.bus.boundary(this.machine);
  }
  advanceFrame(): void {
    this.clock.advance(this, NES_PAL_FRAME_CYCLES);
  }
  enableAudio(sampleRate: number): void {
    if (this.audio?.sampleRate === sampleRate) {
      return;
    }
    this.audio = new NesAudio(this.bus.apu, sampleRate);
    this.bus.apu.onClock = this.audio.tick;
  }
  takeAudio(): Float32Array {
    return this.audio?.take() ?? new Float32Array();
  }
}
export function replayNesControls(recording: readonly RecordedNesControls[]) {
  let index = 0,
    buttons = 0;
  return (frame: number): NesControls => {
    while (index < recording.length && recording[index]!.frame <= frame) {
      buttons = recording[index++]!.buttons;
    }
    return { buttons };
  };
}
