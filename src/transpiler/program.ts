import { decode, disassemble, opcodeFor, type DecodeOptions, type Instruction } from './mos6502.js';
import { AddressSpace } from '../memory.js';
import { liftAddressPages, programFiles, type GeneratedProgram } from './static.js';
import type { RecoveryResult } from './recover.js';
import type { Machine } from '../runtime/mos6502.js';
import { Diagnostic } from '../core.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceObservation } from '../contracts.js';

/** Shared build-time lowering. The browser receives the emitted module only. */
export function emitRecoveredProgram(
  traces: readonly Pick<RecoveryResult, 'variants'>[],
  options: DecodeOptions = {},
  staticInstructions: readonly Instruction[] = [],
) {
  const scratch = new Uint8Array(65536);
  const observations = new Map<string, SourceObservation>();
  const instructions = traces.flatMap((trace) =>
    trace.variants.map((variant) => {
      variant.bytes.forEach((byte, offset) => {
        scratch[(variant.address + offset) & 65535] = byte;
      });
      const instruction = decode(scratch, variant.address, options);
      const key = `${variant.address}:${instruction.opcode}`;
      if (!observations.has(key)) {
        observations.set(key, {
          address: variant.address,
          opcode: instruction.opcode,
          bytes: variant.bytes,
          assembly: variant.text,
          firstInstruction: variant.firstInstruction,
          visits: variant.visits,
          ...(variant.provenance ? { provenance: variant.provenance } : {}),
        });
      }
      return instruction;
    }),
  );
  const program = liftAddressPages([...staticInstructions, ...instructions], {
    runtimeImport: '../runtime/mos6502.js',
  });
  return {
    ...program,
    observations: [...observations.values()]
      .sort((a, b) => a.address - b.address || a.opcode - b.opcode)
      .map((item) => ({
        ...item,
        ...(program.modules
          ? {
              sourceFile: `pages/${((item.address >>> 12) << 12).toString(16).padStart(4, '0')}.ts`,
            }
          : {}),
      })),
  };
}
/** Follow both sides of direct branches/calls in a declared, recovered RAM
 * code region. This is build-time CFG analysis, not byte-by-byte speculation
 * over RAM. Unknown bytes, overlaps and indirect destinations remain gaps. */
export function recoverStaticBranches(
  checkpoint: { ram: ArrayLike<number>; known: ArrayLike<number> },
  seeds: readonly number[],
  range: { start: number; end: number },
  options: DecodeOptions = {},
) {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end > 65536 ||
    range.start >= range.end
  ) {
    throw new Diagnostic('STATIC_CODE_RANGE', 'Invalid recovered code region.');
  }
  const space = new AddressSpace();
  space.bytes.set(checkpoint.ram);
  for (let address = range.start; address < range.end; address++) {
    space.loaded[address] = checkpoint.known[address]!;
  }
  return disassemble(
    space,
    [...new Set(seeds)].filter((address) => address >= range.start && address < range.end),
    16384,
    options,
  );
}
/** Compile possible instruction starts throughout known memory, including
 * targets reached through data tables. This is a conservative coverage envelope,
 * not a claim that every byte is intended code. Unknown opcode bytes stay out;
 * unknown operands remain checked bus reads when the generated code executes. */
export function knownMemoryInstructions(
  memory: { ram: ArrayLike<number>; known: ArrayLike<number> },
  range: { start: number; end: number },
  options: DecodeOptions = {},
): Instruction[] {
  if (
    memory.ram.length !== 65536 ||
    memory.known.length !== 65536 ||
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end > 65536 ||
    range.start >= range.end
  ) {
    throw new Diagnostic(
      'STATIC_CODE_RANGE',
      'Expected a 64 KiB memory image and valid source range.',
    );
  }
  const bytes = Uint8Array.from(memory.ram);
  const instructions: Instruction[] = [];
  for (let address = range.start; address < range.end; address++) {
    if (!memory.known[address] || !opcodeFor(bytes[address]!, options)) {
      continue;
    }
    const instruction = decode(bytes, address, options);
    if (instruction.bytes.some((_, offset) => !memory.known[(address + offset) & 65535])) {
      instruction.text = `${instruction.mnemonic} <operand read from memory at execution>`;
    }
    instructions.push(instruction);
  }
  return instructions;
}

export async function writeStaticProgram(
  program: Pick<GeneratedProgram, 'javascript' | 'modules'>,
  directory: string,
): Promise<void> {
  for (const [name, source] of Object.entries(programFiles(program))) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
}

export async function importStaticProgram<Cpu = Machine>(
  program: Pick<GeneratedProgram, 'javascript' | 'modules'>,
) {
  // Large data-URL module names exceed some JS hosts' limits and pollute error
  // reports with megabytes of source. A private, short-lived module is portable.
  const directory = await mkdtemp(join(tmpdir(), 'romstudio-static-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const path = join(directory, 'program.js');
    await writeStaticProgram(program, directory);
    return (await import(pathToFileURL(path).href)) as { step: (machine: Cpu) => void };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
