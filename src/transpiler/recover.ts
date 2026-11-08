import {
  decode,
  opcodeFor,
  NMOS_EXTENSIONS,
  type Instruction,
  type DecodeOptions,
} from './mos6502.js';
import { lift } from './lift.js';
import { ExecutionGap, Machine } from '../runtime/mos6502.js';

export interface ObservedVariant {
  address: number;
  bytes: number[];
  text: string;
  firstInstruction: number;
  visits: number;
  provenance?: Record<string, unknown>;
}
export interface RecoveryResult {
  stop: 'checkpoint' | 'gap' | 'instruction-budget' | 'variant-budget';
  gap?: { kind: string; address: number; pc: number; detail: string };
  state: ReturnType<Machine['snapshot']>;
  invalidations: number;
  boundaryOperations: number;
  variants: ObservedVariant[];
  recent: { pc: number; text: string }[];
}
export interface RecoveryOptions extends DecodeOptions {
  stopAt: number;
  /** Analysis checkpoints can also depend on observed state (for example a
   * completed input replay). The instruction and service budgets still apply. */
  stopWhen?: (machine: Machine) => boolean;
  maxInstructions: number;
  maxVariants: number;
  onFetch?: (instruction: Instruction) => void;
  describeVariant?: (instruction: Instruction) => Record<string, unknown>;
  onBoundary?: (machine: Machine) => boolean;
  maxBoundaryOperations?: number;
}
/** Recovery-only dynamic translation. Production artifacts use static emitted modules.
 * Code comes exclusively from the fixed CPU backend: names and annotations from
 * input media never enter this compiler. Limits bound instructions and generated functions. */
export function recover(machine: Machine, options: RecoveryOptions): RecoveryResult {
  if (options.undocumentedOpcodes?.some((opcode) => !NMOS_EXTENSIONS.has(opcode))) {
    throw new Error('Recipe requests an unimplemented NMOS opcode extension.');
  }
  if (
    !Number.isInteger(options.stopAt) ||
    options.stopAt < 0 ||
    options.stopAt > 65535 ||
    !Number.isInteger(options.maxInstructions) ||
    options.maxInstructions < 1 ||
    options.maxInstructions > 50000000 ||
    !Number.isInteger(options.maxVariants) ||
    options.maxVariants < 1 ||
    options.maxVariants > 200000
  ) {
    throw new Error(
      'Recovery needs a 16-bit checkpoint, 1–50,000,000 instructions and 1–200,000 variants.',
    );
  }
  const maxBoundaryOperations = options.maxBoundaryOperations ?? 10000;
  if (
    !Number.isInteger(maxBoundaryOperations) ||
    maxBoundaryOperations < 1 ||
    maxBoundaryOperations > 1000000
  ) {
    throw new Error('System boundary budget must be 1–1,000,000.');
  }
  type Compiled = {
    step: (s: Machine) => void;
    instruction: Instruction;
    observation: ObservedVariant;
  };
  const compiled = new Map<string, Compiled>(),
    last = new Map<number, Compiled>();
  const operations = new Map<string, (s: Machine) => void>();
  const scratch = new Uint8Array(65536),
    recent: RecoveryResult['recent'] = [];
  let invalidations = 0,
    stop: RecoveryResult['stop'] = 'instruction-budget';
  let boundaryOperations = 0;
  let gap: RecoveryResult['gap'];
  const initialInstructions = machine.instructions;
  try {
    while (machine.instructions - initialInstructions < options.maxInstructions) {
      if (machine.pc === options.stopAt || options.stopWhen?.(machine)) {
        stop = 'checkpoint';
        break;
      }
      if (options.onBoundary?.(machine)) {
        if (++boundaryOperations > maxBoundaryOperations) {
          machine.gap('service-budget', 'System service/interrupt boundary budget exhausted.');
        }
        continue;
      }
      let block = last.get(machine.pc);
      if (!block) {
        const opcode = machine.bus.peek(machine.pc),
          specification = opcodeFor(opcode, options);
        if (!specification) {
          machine.gap('opcode', `Undocumented or unsupported opcode $${opcode.toString(16)}.`);
        }
        for (let n = 0; n < specification.size; n++) {
          const address = (machine.pc + n) & 65535;
          scratch[address] = machine.bus.peek(address);
        }
        const instruction = decode(scratch, machine.pc, options),
          key = `${instruction.address}:${instruction.bytes.join(',')}`;
        block = compiled.get(key);
        if (!block) {
          if (compiled.size >= options.maxVariants) {
            stop = 'variant-budget';
            break;
          }
          const shape = `${instruction.address}:${instruction.opcode}`;
          let operation = operations.get(shape);
          if (!operation) {
            // Exact variants and their guards remain separate below. Reuse one
            // lowered operation for operand changes instead of generating tens
            // of thousands of duplicate JS functions in a long analysis run.
            const emitted = lift([instruction], { mutableOperands: true });
            const factory = new Function(
              emitted.javascript.replace('export function step(s)', 'return function step(s)'),
            ) as () => (s: Machine) => void;
            operation = factory();
            operations.set(shape, operation);
          }
          const observation: ObservedVariant = {
            address: instruction.address,
            bytes: instruction.bytes,
            text: instruction.text,
            firstInstruction: machine.instructions,
            visits: 0,
            ...(options.describeVariant
              ? { provenance: options.describeVariant(instruction) }
              : {}),
          };
          block = { step: operation, instruction, observation };
          compiled.set(key, block);
        }
        last.set(machine.pc, block);
      }
      try {
        machine.guard(block.instruction.address, block.instruction.bytes);
      } catch (error) {
        if (!(error instanceof ExecutionGap) || error.kind !== 'stale-code') {
          throw error;
        }
        last.delete(machine.pc);
        invalidations++;
        continue;
      }
      options.onFetch?.(block.instruction);
      recent.push({ pc: machine.pc, text: block.instruction.text });
      if (recent.length > 32) {
        recent.shift();
      }
      block.step(machine);
      block.observation.visits++;
    }
    if (machine.pc === options.stopAt || options.stopWhen?.(machine)) {
      stop = 'checkpoint';
    }
  } catch (error) {
    if (!(error instanceof ExecutionGap)) {
      throw error;
    }
    stop = 'gap';
    gap = { kind: error.kind, address: error.address, pc: machine.pc, detail: error.message };
  }
  return {
    stop,
    ...(gap ? { gap } : {}),
    state: machine.snapshot(),
    invalidations,
    boundaryOperations,
    variants: [...compiled.values()].map((b) => b.observation),
    recent,
  };
}
