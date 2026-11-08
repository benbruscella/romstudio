import { FrameClock, type RecoveryGap } from '../../runtime/frame.js';
import { type Machine } from '../../runtime/mos6502.js';
import { restoreC64, type C64Checkpoint } from './snapshot.js';
import { C64RasterDisplay } from './raster.js';
import type { C64SystemBus } from './system.js';
import { SidAudio } from './sid-audio.js';

export interface C64PlayerHooks<Input, Result> {
  controlAddress: number;
  logicAddress?: number;
  applyInput(bus: C64SystemBus, input: Input): void;
  result?(machine: Machine): Result | undefined;
}
export type { RecoveryGap } from '../../runtime/frame.js';

/** Shared static execution, input recording, PAL frame pacing and raster capture.
 * Titles supply observed input/logic boundaries and interpret their own state.
 * The delivered runtime never decodes or compiles a missing instruction. */
export class C64Player<Input, Result = never> {
  readonly bus;
  readonly machine;
  readonly display;
  readonly inputs: (Input & { frame: number })[] = [];
  controlFrames = 0;
  logicTicks = 0;
  outcome: Result | undefined;
  gap: RecoveryGap | undefined;
  private readonly clock: FrameClock;
  private current: string | undefined;
  private sound: SidAudio | undefined;
  constructor(
    checkpoint: C64Checkpoint,
    readonly step: (machine: Machine) => void,
    readonly input: (frame: number, player: C64Player<Input, Result>) => Input,
    readonly hooks: C64PlayerHooks<Input, Result>,
    readonly captureDisplay = true,
  ) {
    const { bus, machine } = restoreC64(checkpoint);
    this.bus = bus;
    this.machine = machine;
    this.display = new C64RasterDisplay(bus, captureDisplay);
    this.clock = new FrameClock(machine.cycles);
    bus.cpuCycle = (cycle, write) => {
      let current = cycle;
      bus.advanceTo(current);
      this.display.capture(bus);
      while (!write && this.display.cpuReadBlocked(bus)) {
        bus.advanceTo(++current);
        this.display.capture(bus);
      }
      return current - cycle;
    };
  }
  boundary(): boolean {
    const s = this.machine;
    if (s.pc === this.hooks.logicAddress) {
      this.logicTicks++;
    }
    if (s.pc === this.hooks.controlAddress) {
      const next = this.input(++this.controlFrames, this),
        serialized = JSON.stringify(next);
      if (serialized !== this.current) {
        this.inputs.push({ frame: this.controlFrames, ...next });
      }
      this.current = serialized;
      this.hooks.applyInput(this.bus, next);
    }
    this.bus.advanceTo(s.cycles);
    this.display.capture(this.bus);
    const serviced = this.bus.boundary(s);
    return serviced;
  }
  enableAudio(sampleRate: number): void {
    if (this.sound) {
      return;
    }
    this.sound = new SidAudio(this.bus.sid, this.bus.clock, sampleRate);
    this.bus.sidWriteObserver = (register, value, cycle) =>
      this.sound!.write(register, value, cycle);
  }
  takeAudio(): Float32Array {
    if (!this.sound) {
      return new Float32Array();
    }
    this.sound.advanceTo(this.bus.clock);
    return this.sound.take();
  }
  advanceFrame(): void {
    this.clock.advance(this, 63 * 312, () => this.hooks.result?.(this.machine));
  }
}
