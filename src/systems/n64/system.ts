import { Vr4300Machine, Vr4300Exception } from '../../runtime/vr4300.js';
import { N64Memory } from './memory.js';
import { RspMachine, type RspProgram } from '../../runtime/rsp.js';

/** Play-tier compiled CPU block: (machine, register words, RDRAM) → retired
 * instructions, or 0 when it did not run. See transpiler/vr4300-blocks.ts. */
export type Vr4300Block = (cpu: Vr4300Machine, words: Int32Array, ram: DataView) => number;

/** Functional N64 bring-up machine. One executed instruction advances one
 * clock tick. This deliberately does not claim cache/pipeline or DMA timing. */
export class N64System {
  readonly memory: N64Memory;
  readonly cpu: Vr4300Machine;
  readonly rsp: RspMachine;
  private readonly idleWords: DataView;
  private signalStep: ((machine: RspMachine) => void) | undefined;
  private signalLinear: RspProgram['prepareLinear'];
  private signalLocal: RspProgram['runLocal'];
  private taskHandler: ((dmem: DataView) => boolean) | undefined;
  private signalPhase = 0;
  private pendingSignalInstruction = false;
  private deviceTicks = 0;
  private deviceDeadline = 0;
  ticks = 0;
  interruptEntries = 0;
  synchronousExceptions = 0;
  /** Host performance observations, excluded from architectural checkpoints. */
  readonly executionStats = {
    rspSpans: 0,
    rspSpanInstructions: 0,
    rspRuns: 0,
    rspRunInstructions: 0,
    deviceBatches: 0,
    highLevelTasks: 0,
    blocks: 0,
    blockInstructions: 0,
  };

  constructor(
    cartridge: Uint8Array,
    entry: number,
    eepromBytes: 0 | 512 | 2048 = 0,
    private readonly batchDevices = false,
  ) {
    this.memory = new N64Memory(cartridge, eepromBytes);
    if (batchDevices) {
      this.memory.beforeDeviceAccess = () => this.flushDevices();
    }
    this.idleWords = new DataView(
      this.memory.ram.bytes.buffer,
      this.memory.ram.bytes.byteOffset,
      this.memory.ram.bytes.byteLength,
    );
    this.cpu = new Vr4300Machine(this.memory, entry, true);
    this.cpu.guestExceptions = true;
    const signal = this.memory.signal;
    this.rsp = new RspMachine({
      data: new DataView(signal.memory.buffer, signal.memory.byteOffset, 4096),
      instruction: (address) => signal.view.getUint32(0x1000 + (address & 0xffc), false),
      readByte: (address) => signal.memory[address & 0xfff]!,
      writeByte: (address, value) => {
        signal.memory[address & 0xfff] = value;
      },
      readControl: (index) => {
        if (batchDevices) {
          this.flushDevices();
        }
        return index < 8
          ? signal.read(index * 4)
          : this.memory.read32(0x04100000 + (index - 8) * 4);
      },
      writeControl: (index, value) => {
        if (batchDevices) {
          this.flushDevices();
        }
        if (index < 8) {
          signal.write(index * 4, value);
        } else {
          this.memory.write32(0x04100000 + (index - 8) * 4, value);
        }
      },
      break: () => {
        if (batchDevices) {
          this.flushDevices();
        }
        signal.break();
      },
    });
  }

  enableRsp(
    step: (machine: RspMachine) => void,
    linear?: RspProgram['prepareLinear'],
    local?: RspProgram['runLocal'],
  ): void {
    this.signalStep = step;
    this.signalLinear = linear;
    this.signalLocal = local;
    this.memory.signal.onStart = () => {
      const signal = this.memory.signal;
      if (this.taskHandler?.(signal.view)) {
        // The microcode would finish by setting SIG2 (task done) and executing
        // BREAK, which halts the RSP and raises the SP interrupt if enabled.
        signal.status |= 0x200;
        signal.break();
        this.executionStats.highLevelTasks++;
        return;
      }
      this.rsp.enter(signal.pc);
    };
  }

  /** Play tier only: a high-level implementation may complete a whole RSP
   * task when it starts. Returning false runs the original microcode. */
  enableTaskHandler(handler: ((dmem: DataView) => boolean) | undefined): void {
    this.taskHandler = handler;
  }

  step(operation: (cpu: Vr4300Machine) => void): void {
    if (this.pendingSignalInstruction) {
      this.advanceClock();
      return;
    }
    if (this.cpu.checkInterrupts(this.memory.interrupts.asserted)) {
      this.interruptEntries++;
    }
    try {
      operation(this.cpu);
    } catch (error) {
      if (!(error instanceof Vr4300Exception)) {
        throw error;
      }
      this.synchronousExceptions++;
    }
    this.advanceClock();
  }

  /** Play tier: run one compiled CPU block, then account its time. Devices
   * see the elapsed time at the block's end or at their next MMIO access, and
   * a running RSP catches up afterwards at its 2:3 clock ratio. The processors
   * interact only through DMA, SP registers, the semaphore and interrupts,
   * which libultra synchronizes; Play accepts this coarser interleaving, while
   * the reference tier keeps exact per-tick lockstep. Interrupts are taken at
   * block boundaries. Returns false when the ordinary step must run instead. */
  runBlock(blocks: ReadonlyMap<number, Vr4300Block>, words: Int32Array, ram: DataView): boolean {
    const cpu = this.cpu,
      asserted = this.memory.interrupts.asserted;
    if (this.pendingSignalInstruction || !cpu.canEnterBlock()) {
      return false;
    }
    let entered = 0;
    if (cpu.checkInterrupts(asserted)) {
      // The handler's first block retires in the same tick as the entry.
      this.interruptEntries++;
      entered = 1;
    }
    const block = blocks.get(cpu.pc);
    let ticks = 0;
    if (block) {
      try {
        ticks = block(cpu, words, ram);
      } catch (error) {
        if (!(error instanceof Vr4300Exception)) {
          throw error;
        }
        this.synchronousExceptions++;
        ticks = cpu.blockTicks;
      }
    }
    if (!ticks) {
      if (!entered) {
        return false;
      }
      // The exception vector has no block: count the entry tick only.
      ticks = 1;
    } else {
      this.executionStats.blocks++;
      this.executionStats.blockInstructions += ticks;
    }
    this.ticks += ticks;
    this.advanceDevices(ticks);
    let phase = this.signalPhase + 2 * ticks;
    while (phase >= 3) {
      phase -= 3;
      if ((this.memory.signal.status & 1) === 0 && this.signalStep) {
        this.pendingSignalInstruction = true;
        this.signalPhase = phase;
        this.completeSignalInstruction();
      }
    }
    this.signalPhase = phase;
    return true;
  }

  /** Coalesce the guarded CPU wait loop only until the next observable
   * clock event. RSP instructions still execute at their original tick;
   * pending interrupts and DMA/PCM/VI events cannot be crossed. */
  advanceIdle(maxTicks = 1000000): number {
    if (this.pendingSignalInstruction || !Number.isSafeInteger(maxTicks) || maxTicks < 1) {
      return 0;
    }
    // Reject ordinary instructions using side-effect-free RDRAM inspection.
    // This is only a candidate filter: the CPU still checks permissions,
    // both instruction words and branch-delay state before any coalescing.
    // Faulting fetches belong to ordinary step(), which delivers the guest
    // exception; this speculative query must not perform a virtual bus read.
    const pc = this.cpu.pc;
    if (pc < 0x80000000 || pc >= 0xc0000000 || pc & 3) {
      return 0;
    }
    const base = (this.cpu.inBranchDelaySlot ? pc - 4 : pc) >>> 0,
      physical = base & 0x1fffffff;
    if (physical + 8 > this.idleWords.byteLength) {
      return 0;
    }

    const branchWord = this.idleWords.getUint32(physical, false);
    if (branchWord !== 0x1000ffff) {
      return 0;
    }
    const slotWord = this.idleWords.getUint32(physical + 4, false);
    if (slotWord !== 0) {
      return 0;
    }
    const status = this.cpu.control.read(12),
      cause = this.cpu.control.read(13);
    if (
      status & 1 &&
      !(status & 6) &&
      (cause & status & 0xff00 || (this.memory.interrupts.asserted && status & 0x400))
    ) {
      return 0;
    }
    if (!this.cpu.canAdvanceIdleLoop(branchWord, slotWord)) {
      return 0;
    }
    if (this.batchDevices) {
      this.flushDevices();
    }
    const active = (this.memory.signal.status & 1) === 0 && !!this.signalStep;
    const event = Math.min(
      this.cpu.control.ticksUntilCompare(),
      this.memory.peripheral.ticksUntilEvent(),
      this.memory.serial.ticksUntilEvent(),
      this.memory.signal.ticksUntilEvent(),
      this.memory.audio.ticksUntilEvent(),
      this.memory.video.ticksUntilInterrupt(),
    );
    // Local RSP operations cannot touch RDRAM, devices or the CPU's wait
    // words. Execute them within a strict event budget, then commit the same
    // elapsed CPU/device time. Branches may choose their original next word;
    // writes, semaphore reads, BREAK and faulting instructions stop the run.
    // Status/DMA/DPC reads stay constant strictly before this event deadline.
    // No CPU/device observation can distinguish this order inside the budget.
    if (active && this.signalLocal) {
      const available = Math.min(maxTicks, 384, event - 1),
        limit = Math.floor((available * 2 + this.signalPhase) / 3);
      if (limit >= 4) {
        const before = this.rsp.instructions,
          count = this.signalLocal(this.rsp, limit, true, true);
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > limit ||
          this.rsp.instructions - before !== count
        ) {
          throw new Error('The static RSP run exceeded its instruction/event budget.');
        }
        if (count) {
          const elapsed = Math.ceil((count * 3 - this.signalPhase) / 2);
          if (!this.cpu.advanceIdleLoop(elapsed, branchWord, slotWord)) {
            throw new Error('Local RSP work invalidated the checked CPU wait loop.');
          }
          this.cpu.checkInterrupts(this.memory.interrupts.asserted);
          this.advanceDevices(elapsed);
          this.signalPhase += elapsed * 2 - count * 3;
          this.memory.signal.pc = this.rsp.pc;
          this.ticks += elapsed;
          this.executionStats.rspRuns++;
          this.executionStats.rspRunInstructions += count;
          return elapsed;
        }
      }
    }
    // Only register/private-DMEM work is grouped. No device/control access,
    // branch or BREAK may be inside the span. Stop strictly before
    // the next device event, and require the CPU's wait loop to live in RDRAM
    // so RSP data memory cannot change its instructions.
    if (active && this.signalLinear && (this.cpu.pc & 0x1fffffff) < this.memory.ram.bytes.length) {
      const available = Math.min(maxTicks, 96, event - 1);
      const limit = Math.floor((available * 2 + this.signalPhase) / 3);
      if (limit >= 4) {
        const block = this.signalLinear(this.rsp, limit);
        if (block) {
          if (
            !Number.isSafeInteger(block.instructions) ||
            block.instructions < 4 ||
            block.instructions > limit
          ) {
            throw new Error('The static RSP span exceeds its device-event budget.');
          }
          const elapsed = Math.ceil((block.instructions * 3 - this.signalPhase) / 2);
          if (!this.cpu.advanceIdleLoop(elapsed, branchWord, slotWord)) {
            return 0;
          }
          this.cpu.checkInterrupts(this.memory.interrupts.asserted);
          this.advanceDevices(elapsed);
          block.execute();
          this.executionStats.rspSpans++;
          this.executionStats.rspSpanInstructions += block.instructions;
          this.signalPhase += elapsed * 2 - block.instructions * 3;
          this.memory.signal.pc = this.rsp.pc;
          this.ticks += elapsed;
          return elapsed;
        }
      }
    }
    const ticks = Math.max(
      1,
      Math.min(maxTicks, 1000000, event, active ? Math.ceil((3 - this.signalPhase) / 2) : Infinity),
    );
    if (!this.cpu.advanceIdleLoop(ticks, branchWord, slotWord)) {
      return 0;
    }
    // Ordinary step refreshes the external Cause bit before retiring each
    // instruction. No interrupt is accepted on this checked fast path.
    this.cpu.checkInterrupts(this.memory.interrupts.asserted);
    this.advanceDevices(ticks);
    this.signalPhase += 2 * ticks;
    if (active && this.signalPhase >= 3) {
      this.signalPhase -= 3;
      this.ticks += ticks - 1;
      this.pendingSignalInstruction = true;
      this.completeSignalInstruction();
      this.ticks++;
    } else {
      this.signalPhase %= 3;
      this.ticks += ticks;
    }
    return ticks;
  }

  /** Advance one functional CPU-clock tick. Also used by explicitly paused-CPU
   * device fixtures; it does not retire a CPU instruction by itself. */
  advanceClock(): void {
    if (this.pendingSignalInstruction) {
      this.completeSignalInstruction();
      this.ticks++;
      return;
    }
    this.advanceDevices(1);
    this.signalPhase += 2;
    if (this.signalPhase >= 3) {
      this.signalPhase -= 3;
      if ((this.memory.signal.status & 1) === 0 && this.signalStep) {
        // A debugger stop or backend gap can interrupt the RSP after the
        // CPU and devices advanced. Retain that exact continuation so resume
        // never executes the CPU twice or skips the pending RSP instruction.
        this.pendingSignalInstruction = true;
        this.completeSignalInstruction();
      }
    }
    this.ticks++;
  }

  /** Keep Count current on every instruction. The other devices advance as
   * a group only up to their earliest event. MMIO and debugger snapshots flush
   * the elapsed time before observing or changing device state. RSP execution
   * still occurs at the original 2:3 clock phase on every ordinary tick. */
  private advanceDevices(ticks: number): void {
    this.cpu.control.advance(ticks);
    if (!this.batchDevices) {
      this.advanceDeviceGroup(ticks);
      return;
    }
    if (this.deviceDeadline <= 0) {
      this.deviceDeadline = Math.min(
        this.memory.peripheral.ticksUntilEvent(),
        this.memory.serial.ticksUntilEvent(),
        this.memory.video.ticksUntilInterrupt(),
        this.memory.audio.ticksUntilEvent(),
        this.memory.signal.ticksUntilEvent(),
      );
    }
    this.deviceTicks += ticks;
    this.deviceDeadline -= ticks;
    if (this.deviceDeadline <= 0) {
      this.flushDevices();
    }
  }

  private flushDevices(): void {
    const ticks = this.deviceTicks;
    // A caller may change registers immediately after this flush.
    this.deviceTicks = 0;
    this.deviceDeadline = 0;
    if (ticks) {
      this.advanceDeviceGroup(ticks);
    }
  }

  private advanceDeviceGroup(ticks: number): void {
    this.memory.peripheral.advance(ticks);
    this.memory.serial.advance(ticks);
    this.memory.video.advance(ticks);
    this.memory.audio.advance(ticks);
    this.memory.signal.advance(ticks);
    this.executionStats.deviceBatches++;
  }

  private completeSignalInstruction(): void {
    if (!this.signalStep) {
      throw new Error('Install the RSP program before resuming its pending instruction.');
    }
    this.signalStep(this.rsp);
    this.memory.signal.pc = this.rsp.pc;
    this.pendingSignalInstruction = false;
  }

  snapshot() {
    if (this.batchDevices) {
      this.flushDevices();
    }
    return {
      cpu: this.cpu.snapshot(),
      devices: this.memory.snapshot(),
      ticks: this.ticks,
      interruptEntries: this.interruptEntries,
      synchronousExceptions: this.synchronousExceptions,
      rsp: this.rsp.snapshot(),
      signalPhase: this.signalPhase,
      pendingSignalInstruction: this.pendingSignalInstruction,
    };
  }
  /** Restore architectural/device state after installing matching cartridge,
   * EEPROM, RDRAM and SP bytes. Execution callbacks remain caller-owned. */
  restore(state: ReturnType<N64System['snapshot']>): void {
    this.deviceTicks = 0;
    this.deviceDeadline = 0;
    this.cpu.restore(state.cpu);
    this.rsp.restore(state.rsp);
    this.memory.restore(state.devices);
    this.ticks = state.ticks;
    this.interruptEntries = state.interruptEntries;
    this.synchronousExceptions = state.synchronousExceptions;
    this.signalPhase = state.signalPhase;
    this.pendingSignalInstruction = state.pendingSignalInstruction;
  }
}
