import type { SourceObservation } from '../contracts.js';
import type { RspMachine } from '../runtime/rsp.js';
import { compileRsp, decodeRsp, liftRsp, type RspInstruction } from './rsp.js';

/** Build-time evidence collection, shared by RSP tasks. The web receives
 * emitted static functions and these observations; it never runs this decoder. */
export class RspRecovery {
  private readonly shapes = new Map<
    string,
    {
      instruction: RspInstruction;
      observation: SourceObservation;
      operation: (machine: RspMachine, fetchedWord?: number) => void;
    }
  >();
  private observedInstructions = 0;

  constructor(public trace: string) {}

  readonly step = (machine: RspMachine): void => {
    const word = machine.bus.instruction(machine.pc),
      key = `${machine.pc}:${word}`;
    let shape = this.shapes.get(key);
    if (!shape) {
      const instruction = decodeRsp(word, machine.pc);
      shape = {
        instruction,
        operation: compileRsp(instruction),
        observation: {
          address: machine.pc,
          opcode: word,
          bytes: instruction.bytes,
          assembly: instruction.text,
          firstInstruction: this.observedInstructions,
          visits: 0,
          provenance: {
            addressSpace: 'rsp-imem',
            traces: [],
            evidence:
              'observed original microcode word; DMA can replace IMEM; instruction counter concatenates declared fixtures',
          },
        },
      };
      this.shapes.set(key, shape);
    }
    const traces = shape.observation.provenance!.traces as string[];
    if (!traces.includes(this.trace)) {
      traces.push(this.trace);
    }
    shape.observation.visits++;
    this.observedInstructions++;
    shape.operation(machine, word);
  };

  get shapeCount(): number {
    return this.shapes.size;
  }

  get observations(): SourceObservation[] {
    return [...this.shapes.values()]
      .map((shape) => shape.observation)
      .sort((a, b) => a.address - b.address || a.opcode - b.opcode);
  }

  emit() {
    return liftRsp([...this.shapes.values()].map((shape) => shape.instruction));
  }
}
