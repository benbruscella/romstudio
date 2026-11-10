import { Diagnostic, type SourceObservation } from '../contracts.js';
import type { Vr4300Machine } from '../runtime/vr4300.js';
import type { RspMachine } from '../runtime/rsp.js';
import { decodeVr4300, compileVr4300, liftVr4300Pages, type Vr4300Instruction } from './vr4300.js';
import { decodeRsp, compileRsp, liftRsp, type RspInstruction } from './rsp.js';

/** Build-time recovery for the two N64 instruction sets. Observed execution
 * and conservative coverage envelopes remain separate evidence. The browser
 * receives only statically lowered functions with address/word guards. */
export class N64Recovery {
  readonly idleAddresses = new Set<number>();
  private readonly cpu = new Map<string, Vr4300Instruction>();
  private readonly rsp = new Map<string, RspInstruction>();
  private readonly cpuHot = new Map<
    number,
    {
      word: number;
      run: (s: Vr4300Machine, fetchedWord?: number) => void;
      observation: SourceObservation;
    }
  >();
  private readonly rspHot = new Map<
    number,
    {
      word: number;
      run: (s: RspMachine, fetchedWord?: number) => void;
      observation: SourceObservation;
    }
  >();
  private readonly observedCpu = new Map<string, SourceObservation>();
  private readonly observedRsp = new Map<string, SourceObservation>();

  readonly stepCpu = (machine: Vr4300Machine): void => {
    const word = machine.bus.read32(machine.pc);
    if (word === 0x1000ffff) {
      this.idleAddresses.add(machine.pc);
      this.idleAddresses.add((machine.pc + 4) >>> 0);
    }
    // Aligned word indices fit small integers; retain full byte addresses in
    // the instruction records and guards, including distinct virtual aliases.
    const index = machine.pc >>> 2;
    let item = this.cpuHot.get(index);
    if (!item || item.word !== word) {
      const instruction = decodeVr4300(word, machine.pc),
        key = `${machine.pc}:${word}`;
      const observation =
        this.observedCpu.get(key) ??
        this.observation(instruction, machine.instructions, 'vr4300-cpu');
      this.cpu.set(key, instruction);
      this.observedCpu.set(key, observation);
      item = { word, run: compileVr4300(instruction), observation };
      this.cpuHot.set(index, item);
    }
    item.observation.visits++;
    item.run(machine, word);
  };

  readonly stepRsp = (machine: RspMachine): void => {
    const word = machine.bus.instruction(machine.pc);
    let item = this.rspHot.get(machine.pc);
    if (!item || item.word !== word) {
      const instruction = decodeRsp(word, machine.pc),
        key = `${machine.pc}:${word}`;
      const observation =
        this.observedRsp.get(key) ??
        this.observation(instruction, machine.instructions, 'rsp-imem');
      this.rsp.set(key, instruction);
      this.observedRsp.set(key, observation);
      item = { word, run: compileRsp(instruction), observation };
      this.rspHot.set(machine.pc, item);
    }
    item.observation.visits++;
    item.run(machine, word);
  };

  includeCpuMemory(ram: Uint8Array, start: number, end: number): void {
    if (
      start % 4 ||
      end % 4 ||
      start < 0x80000000 ||
      end <= start ||
      end - 0x80000000 > ram.length
    ) {
      throw new Diagnostic(
        'N64_CODE_RANGE',
        'Expected an aligned KSEG0 range within captured RDRAM.',
      );
    }
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    for (let address = start; address < end; address += 4) {
      const word = view.getUint32(address - 0x80000000, false);
      try {
        this.cpu.set(`${address}:${word}`, decodeVr4300(word, address));
      } catch (error) {
        if (!(error instanceof Diagnostic) || error.code !== 'MIPS_UNSUPPORTED_OPCODE') {
          throw error;
        }
      }
    }
  }

  includeRspMemory(memory: Uint8Array): void {
    if (memory.length !== 4096) {
      throw new Diagnostic('N64_CODE_RANGE', 'Expected a complete 4 KiB IMEM image.');
    }
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    for (let address = 0; address < 4096; address += 4) {
      const word = view.getUint32(address, false);
      try {
        this.rsp.set(`${address}:${word}`, decodeRsp(word, address));
      } catch (error) {
        if (
          !(error instanceof Diagnostic) ||
          !['MIPS_UNSUPPORTED_OPCODE', 'RSP_OPCODE'].includes(error.code)
        ) {
          throw error;
        }
      }
    }
  }

  emit() {
    return { cpu: liftVr4300Pages([...this.cpu.values()]), rsp: liftRsp([...this.rsp.values()]) };
  }
  observations(processor: 'cpu' | 'rsp'): SourceObservation[] {
    return [...(processor === 'cpu' ? this.observedCpu : this.observedRsp).values()]
      .sort((a, b) => a.address - b.address || a.opcode - b.opcode)
      .map((item) => ({
        ...item,
        ...(processor === 'cpu'
          ? { sourceFile: `pages/${Math.floor(item.address / 4096).toString(16)}000.ts` }
          : {}),
      }));
  }
  private observation(
    instruction: Vr4300Instruction,
    firstInstruction: number,
    addressSpace: string,
  ): SourceObservation {
    return {
      address: instruction.address,
      opcode: instruction.word,
      bytes: instruction.bytes,
      assembly: instruction.text,
      firstInstruction,
      visits: 0,
      provenance: {
        addressSpace,
        evidence: 'observed execution; unvisited envelope words are not observations',
      },
    };
  }
}
