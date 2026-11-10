import { ExecutionGap, Machine } from '../../../../runtime/mos6502.js';
import type { C64SystemBus } from '../../../../systems/c64/system.js';

export interface BootInput {
  pc: number;
  kind: 'space' | 'trainer-no';
  caller?: number;
  screenCodes?: number[];
}

export interface TitleFile {
  bytes: Uint8Array;
  mediaHash: string;
  fileId: string;
}

export interface CompressedBlock {
  headerOffset: number;
  compressedBytes: number;
  destinationEnd: number;
  initialBitBuffer: number;
}

/** Five-byte block headers use big-endian words, whereas 6502 instruction
 * operands use little-endian words. A file can contain several blocks: CB is
 * an observed example. The original CE7C routine still does the decompression. */
export function inspectCompressedBlocks(bytes: Uint8Array): CompressedBlock[] {
  const blocks: CompressedBlock[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 5 > bytes.length) {
      throw new Error('Truncated compressed block header.');
    }
    const compressedBytes = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (offset + 5 + compressedBytes > bytes.length) {
      throw new Error('Compressed block overruns its file.');
    }
    blocks.push({
      headerOffset: offset,
      compressedBytes,
      destinationEnd: (bytes[offset + 2]! << 8) | bytes[offset + 3]!,
      initialBitBuffer: bytes[offset + 4]!,
    });
    offset += 5 + compressedBytes;
  }
  if (!blocks.length) {
    throw new Error('Compressed file has no blocks.');
  }
  return blocks;
}

/** Title knowledge belongs here rather than in the shared CPU or C64 hardware.
 * These are explanatory names; the original author's symbol names are unknown.
 * See src/games/c64/lemmings/docs/BOOT.md for the evidence behind each recovered boundary. */
export class LemmingsBoot {
  readonly inputs: BootInput[] = [];
  readonly diskReads: {
    name: string;
    mediaHash: string;
    fileId: string;
    length: number;
    consumed: number;
    blocks: CompressedBlock[];
    complete: boolean;
  }[] = [];

  relocationCount = 0;
  deadFlagReads = 0;
  private stream: { file: TitleFile; position: number } | undefined;
  private releaseExitSeen = false;
  startupComplete = false;

  constructor(
    readonly bus: C64SystemBus,
    readonly machine: Machine,
    readonly files: Pick<ReadonlyMap<string, TitleFile>, 'get'> = new Map(),
  ) {
    bus.kernal.characterInput = () => this.answerTrainerPrompt();
  }

  private startCompressedFile(machine: Machine): void {
    machine.guard(0xce00, [0xa2, 8, 0x20, 0xba, 0xff, 0xa9, 8]);
    if (machine.read(0xb7) !== 2 || machine.read(0xba) !== 8) {
      throw new ExecutionGap('disk-request', machine.pc, 'Expected a two-letter file on drive 8.');
    }
    const filenamePointer = machine.word(0xbb);
    const name = String.fromCharCode(
      machine.read(filenamePointer),
      machine.read(filenamePointer + 1),
    );
    const file = this.files.get(name);
    if (!file) {
      throw new ExecutionGap(
        'missing-disk-file',
        machine.pc,
        `File '${name}' is not present on the selected disk.`,
      );
    }

    let blocks: CompressedBlock[];
    try {
      blocks = inspectCompressedBlocks(file.bytes);
    } catch (error) {
      throw new ExecutionGap(
        'compressed-file-header',
        machine.pc,
        `${name}: ${(error as Error).message}`,
      );
    }
    this.stream = { file, position: 0 };
    this.diskReads.push({
      name,
      mediaHash: file.mediaHash,
      fileId: file.fileId,
      length: file.bytes.length,
      consumed: 0,
      blocks,
      complete: false,
    });

    // Reproduce the setup consumed by the receive/decompression routines.
    machine.write(0xd015, 0); // Disable sprites during the load.
    machine.write(0xcf5d, (machine.read(0xd011) & 7) + 0x2f);
    const videoBankPins = machine.read(0xdd00) & 7;
    const serialClockPins = videoBankPins | 0x20;
    machine.write(0xdd00, videoBankPins);
    machine.write(0xa3, serialClockPins);
    machine.write(0xcf7f, ((serialClockPins >>> 2) ^ serialClockPins) & 7);

    // Resume the original header loop and CE7C decompressor. The transport
    // supplies bytes from the selected disk instead of bit-banging a drive.
    machine.pc = 0xce58;
    machine.cycles += 40;
  }

  private receiveDiskByte(machine: Machine): void {
    if (!this.stream) {
      throw new ExecutionGap('disk-stream', machine.pc, 'No selected disk stream.');
    }
    const { file, position } = this.stream;
    if (position === file.bytes.length) {
      machine.write(0x90, 0x40); // KERNAL end-of-file status.
      machine.a = 0;
    } else {
      machine.a = file.bytes[position]!;
      this.stream.position++;
      this.diskReads.at(-1)!.consumed++;
    }
    // The original receiver restores X with LDX before RTS; Y is preserved.
    machine.nz(machine.x);
    machine.pc = ((machine.pop() | (machine.pop() << 8)) + 1) & 65535;
    machine.cycles += 40; // Functional transport timing, not physical IEC timing.
  }

  private finishCompressedFile(machine: Machine): void {
    const read = this.diskReads.at(-1)!;
    if (read.consumed !== read.length) {
      throw new ExecutionGap(
        'disk-stream',
        machine.pc,
        'Loader stopped before consuming the file.',
      );
    }
    read.complete = true;
    this.stream = undefined;
    machine.a = 0;
    machine.flag(1, false);
    machine.flag(4, false);
    machine.pc = ((machine.pop() | (machine.pop() << 8)) + 1) & 65535;
    machine.cycles += 20;
  }

  private answerTrainerPrompt(): number {
    if (this.startupComplete) {
      return 0;
    }
    const machine = this.machine;
    const returnLow = machine.read(0x100 | ((machine.sp + 1) & 255));
    const returnHigh = machine.read(0x100 | ((machine.sp + 2) & 255));
    const caller = ((returnLow | (returnHigh << 8)) + 1) & 65535;

    // A trainer prompt compares GETIN's result with Y, then N. Match that
    // recovered instruction pattern, so later keyboard callers stay untouched.
    const compareYes = [0xc9, 0x59, 0xf0];
    const isTrainerPrompt =
      caller >= 0x9000 &&
      caller < 0x9380 &&
      compareYes.every((byte, index) => this.bus.peek(caller + index) === byte) &&
      this.bus.peek(caller + 4) === 0xc9 &&
      this.bus.peek(caller + 5) === 0x4e;
    if (!isTrainerPrompt) {
      return 0;
    }

    this.inputs.push({
      pc: machine.pc,
      kind: 'trainer-no',
      caller,
      screenCodes: [...this.bus.bytes.subarray(0x400, 0x7e8)],
    });
    return 0x4e; // PETSCII N, following the original "no" branch.
  }

  /** The release copies 199 RAM pages, including unused, uninitialised padding.
   * INY replaces LDA's flags before BNE: no branch depends on the copied data.
   * This guarded bulk operation preserves both values and their known/unknown
   * status. It does not turn unknown padding into recovered zero-filled data.
   * Original routine: $0405–$041B, copied from $2D07–$2D1D. */
  relocateLoaderPayload(machine: Machine): void {
    const expected = [
      0xa0, 0, 0xb1, 2, 0x91, 4, 0xc8, 0xd0, 0xf9, 0xe6, 5, 0xe6, 3, 0xd0, 0xf1, 0xa9, 0x37, 0x85,
      1, 0x58, 0x4c, 1, 8,
    ];
    machine.guard(0x405, expected);
    if (
      !(machine.p & 4) ||
      machine.read(1) !== 0x34 ||
      machine.word(2) !== 0x3901 ||
      machine.word(4) !== 0x801
    ) {
      throw new ExecutionGap(
        'title-annotation',
        machine.pc,
        'Loader relocation preconditions do not match the reviewed loop.',
      );
    }

    for (let offset = 0; offset < 199 * 256; offset++) {
      const source = (0x3901 + offset) & 65535;
      const destination = 0x801 + offset;
      const sourceIsKnown = this.bus.known[source]!;
      const value = this.bus.bytes[source]!;
      this.bus.writerPc = 0x409;
      machine.write(destination, value);
      this.bus.known[destination] = sourceIsKnown;
    }
    this.bus.writerPc = 0x40e;
    machine.write(5, 0xcf);
    this.bus.writerPc = 0x410;
    machine.write(3, 0);
    this.bus.writerPc = 0x416;
    machine.write(1, 0x37);
    machine.y = 0;
    machine.a = machine.nz(0x37);
    machine.flag(4, false);
    machine.pc = 0x801;
    machine.instructions += 204576;
    machine.cycles += 818098;
    this.relocationCount++;
  }

  boundary(machine: Machine): boolean {
    if (
      !this.startupComplete &&
      machine.pc === 0x91c4 &&
      this.inputs.filter((input) => input.kind === 'trainer-no').length === 12 &&
      [0xad, 0x77, 0xa2, 0xcd, 0x38, 0xcb].every(
        (byte, offset) => this.bus.bytes[0x91c4 + offset] === byte,
      )
    ) {
      this.startupComplete = true;
    }
    if (!this.startupComplete && (machine.pc === 0x2caf || machine.pc === 0x0f2e)) {
      if (!this.bus.cia1.space) {
        this.inputs.push({ pc: machine.pc, kind: 'space' });
      }
      this.bus.cia1.space = true;
    }
    if (!this.startupComplete && machine.pc === 0x2cb7) {
      this.releaseExitSeen = true;
      this.bus.cia1.space = false;
    }
    if (!this.startupComplete && machine.pc === 0x0f33) {
      this.bus.cia1.space = false;
    }
    if (machine.pc === 0x405 && this.releaseExitSeen && this.relocationCount === 0) {
      this.relocateLoaderPayload(machine);
      return true;
    }
    if (machine.pc === 0xce00) {
      this.startCompressedFile(machine);
      return true;
    }
    if (machine.pc === 0xcf4d) {
      this.receiveDiskByte(machine);
      return true;
    }
    if (machine.pc === 0xce76 && this.stream) {
      this.finishCompressedFile(machine);
      return true;
    }
    if (machine.pc === 0xcf04 && this.stream && !this.bus.known[0x68]) {
      // BIT $68 skips an embedded PLA opcode at CF05. The following PLA
      // replaces N/Z, and the decompressor never tests V. Record the unused
      // flag read as a reviewed annotation, preserving carry and unknown RAM.
      machine.guard(0xcf04, [0x24, 0x68, 0x68, 0x60]);
      machine.pc = 0xcf06;
      machine.cycles += 3;
      machine.instructions++;
      this.deadFlagReads++;
      return true;
    }
    return this.bus.boundary(machine);
  }
}
