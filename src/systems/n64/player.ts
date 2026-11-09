import type { Vr4300Machine } from '../../runtime/vr4300.js';
import { Vr4300Gap } from '../../runtime/vr4300.js';
import { RspGap, type RspMachine, type RspProgram } from '../../runtime/rsp.js';
import { N64System, type Vr4300Block } from './system.js';
import { lowRegisterWord } from '../../runtime/register-words.js';
import { clearN64Trace, type N64Launch } from './checkpoint.js';
import { N64Controls } from './input.js';
import { renderN64ColorImage } from './render.js';
import { DisplaySink, Fast3dTasks } from './fast3d.js';
import { RdpStreamSink, type RdpFrame } from './rdp-stream.js';

export interface N64PlayerGap {
  kind: string;
  address: number;
  pc: number;
  detail: string;
}

/** Runs static original CPU/RSP functions. Browser scheduling and presentation
 * live in web/; this class owns the machine, SI sampling and captured PCM. */
export class N64Player {
  readonly system: N64System;
  readonly controls = new N64Controls();
  gap: N64PlayerGap | undefined;
  private samples: number[] = [];
  private samplePhase = 0;
  private outputRate = 44100;
  private blocks: ReadonlyMap<number, Vr4300Block> | undefined;
  private blockWords: Int32Array = new Int32Array(0);
  private blockRam: DataView = new DataView(new ArrayBuffer(0));

  constructor(
    readonly launch: N64Launch,
    cartridge: Uint8Array,
    ram: Uint8Array,
    signal: Uint8Array,
    private readonly cpu: (s: Vr4300Machine) => void,
    rsp: (s: RspMachine) => void,
    linear?: RspProgram['prepareLinear'],
    private readonly idleAddresses?: ReadonlySet<number>,
    local?: RspProgram['runLocal'],
  ) {
    if (launch.schemaVersion !== 1 || ram.length !== 4194304 || signal.length !== 8192) {
      throw new Error('Invalid N64 launch memories.');
    }
    const s = (this.system = new N64System(cartridge, 0, 512, true));
    s.memory.ram.bytes.set(ram);
    s.memory.signal.memory.set(signal);
    s.enableRsp(rsp, linear, local);
    s.restore(launch.state);
    s.memory.serial.onControllerRead = () => Object.assign(s.memory.serial, this.controls.sample());
    s.memory.audio.output = (left, right, rate) => {
      this.samplePhase += this.outputRate / rate;
      while (this.samplePhase >= 1) {
        this.samples.push(left, right);
        this.samplePhase--;
      }
    };
  }

  /** Play tier: complete recognized Fast3D graphics tasks with the high-level
   * implementation. Unrecognized or unsupported tasks run the original
   * microcode. Learn, ROM Desk and verification keep the reference tier. */
  /** Play tier: run compiled CPU basic blocks while the RSP is halted. The
   * generated blocks address registers as little-endian low/high words. */
  enableBlocks(blocks: ReadonlyMap<number, Vr4300Block>): boolean {
    if (lowRegisterWord !== 0) {
      return false;
    }
    const registers = this.system.cpu.registers,
      ram = this.system.memory.ram.bytes;
    this.blocks = blocks;
    this.blockWords = new Int32Array(registers.buffer, registers.byteOffset, registers.length * 2);
    this.blockRam = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    return true;
  }

  enablePlayTier(stream?: (frame: RdpFrame) => void): Fast3dTasks {
    const memory = this.system.memory,
      sink = stream
        ? new RdpStreamSink(memory.ram.bytes, memory.display, stream)
        : new DisplaySink(memory.display);
    const graphics = new Fast3dTasks(memory.ram.bytes, sink);
    this.system.enableTaskHandler((dmem) => graphics.run(dmem));
    return graphics;
  }

  enableAudio(rate: number): void {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
      throw new Error('Invalid audio sample rate.');
    }
    this.outputRate = rate;
  }
  takeAudio(): Float32Array {
    const output = Float32Array.from(this.samples);
    this.samples = [];
    return output;
  }
  pixels(): Uint8Array {
    return renderN64ColorImage(
      this.system.memory.ram.bytes,
      this.system.memory.display.colorImage,
      this.launch.height,
    );
  }
  /** Bound work by both elapsed time and loop iterations. Interrupts and DMA
   * retain the machine's functional tick ordering; only the host yields. */
  advance(milliseconds = 8): { frame: boolean; ticks: number } {
    const s = this.system,
      initial = s.ticks,
      sync = s.memory.display.fullSyncs;
    const deadline = performance.now() + milliseconds;
    try {
      let loops = 0;
      let checkAt = initial + 256;
      while (!this.gap && loops++ < 100000) {
        // A local RSP batch can cover hundreds of guest ticks in one loop.
        // Bound host yields by elapsed guest work, not dispatch count.
        if (s.ticks >= checkAt) {
          checkAt = s.ticks + 256;
          if (performance.now() >= deadline) {
            break;
          }
        }
        if ((this.idleAddresses && !this.idleAddresses.has(s.cpu.pc)) || !s.advanceIdle()) {
          if (!this.blocks || !s.runBlock(this.blocks, this.blockWords, this.blockRam)) {
            s.step(this.cpu);
          }
        }
        if (s.memory.display.fullSyncs !== sync) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof Vr4300Gap) {
        this.gap = {
          kind: error.kind,
          address: error.address,
          pc: s.cpu.pc,
          detail: error.message,
        };
      } else if (error instanceof RspGap) {
        this.gap = { kind: error.kind, address: error.pc, pc: s.cpu.pc, detail: error.message };
      } else {
        throw error;
      }
    }
    clearN64Trace(s);
    return { frame: s.memory.display.fullSyncs !== sync, ticks: s.ticks - initial };
  }
}
