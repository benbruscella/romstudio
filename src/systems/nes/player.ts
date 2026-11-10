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
  readonly clock: FrameClock;
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
    this.runFrame();
  }
  /** ROM Desk: continue the current frame, pausing before the boundary
   * service or instruction for which `stop` returns true. */
  runFrame(stop?: (machine: Machine) => boolean): boolean {
    return this.clock.advance(this, NES_PAL_FRAME_CYCLES, undefined, stop);
  }
  /** Side-effect-free CPU read; device registers are not read. */
  peek(address: number): number | undefined {
    try {
      return this.bus.peek(address & 0xffff);
    } catch {
      return undefined;
    }
  }
  /** Address-space identity of `address`: RAM, or the PRG bank mapped there. */
  identity(address: number): string {
    if (address < 0x2000) {
      return 'internal RAM';
    }
    if (address < 0x8000) {
      return address >= 0x6000 ? 'cartridge RAM' : 'device registers';
    }
    const offset = this.bus.cartridge.prgOffset(address);
    const hex = offset.toString(16).padStart(5, '0').toUpperCase();
    return `PRG bank ${Math.floor(offset / 16384)} · ROM offset $${hex}`;
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
