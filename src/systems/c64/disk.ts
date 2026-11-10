import { ExecutionGap, type Machine } from '../../runtime/mos6502.js';

export interface C64DiskFile {
  bytes: Uint8Array;
  mediaHash: string;
  fileId: string;
}

/** Functional KERNAL LOAD for an exact, pinned filename.
 *
 * SETNAM supplies the name through $B7/$BB, and SETLFS supplies drive and
 * secondary address through $BA/$B9. A secondary address of zero loads at X/Y;
 * otherwise the PRG's two-byte header determines the destination.
 *
 * This transfers the original bytes and reproduces the observed LOAD return
 * contract. Drive execution, serial handshaking and physical timing are outside
 * this service. Unsupported requests stop with an explicit execution gap.
 */
export function loadDiskPrg(
  machine: Machine,
  files: Pick<ReadonlyMap<string, C64DiskFile>, 'get'>,
) {
  if (machine.a !== 0) {
    throw new ExecutionGap('disk-verify', machine.pc, 'KERNAL VERIFY is not implemented.');
  }

  const filenameLength = machine.read(0xb7);
  const filenameAddress = machine.word(0xbb);
  const drive = machine.read(0xba);
  const secondaryAddress = machine.read(0xb9);

  if (drive !== 8 || filenameLength < 1 || filenameLength > 16) {
    throw new ExecutionGap('disk-request', machine.pc, 'LOAD requires a named file on drive 8.');
  }

  const nameBytes = Array.from({ length: filenameLength }, (_, offset) =>
    machine.read(filenameAddress + offset),
  );
  const name = String.fromCharCode(...nameBytes);
  const file = files.get(name);

  if (!file) {
    throw new ExecutionGap(
      'missing-disk-file',
      machine.pc,
      `File '${name}' is not present on the pinned disk.`,
    );
  }
  if (file.bytes.length < 2) {
    throw new ExecutionGap('disk-prg', machine.pc, 'LOAD received a truncated PRG header.');
  }

  const requestedAddress = machine.x | (machine.y << 8);
  const headerAddress = file.bytes[0]! | (file.bytes[1]! << 8);
  const start = secondaryAddress === 0 ? requestedAddress : headerAddress;
  const payload = file.bytes.subarray(2);
  const end = start + payload.length; // Exclusive end address, as returned by LOAD.

  if (start < 0x400 || end > 0xd000) {
    throw new ExecutionGap(
      'disk-range',
      machine.pc,
      'This LOAD contract supports RAM destinations $0400–$CFFF without wrapping.',
    );
  }

  for (let offset = 0; offset < payload.length; offset++) {
    machine.write(start + offset, payload[offset]!);
  }

  // KERNAL end pointer, successful status, and returned X/Y registers.
  machine.write(0xae, end & 0xff);
  machine.write(0xaf, end >>> 8);
  machine.write(0x90, 0);
  machine.x = end & 0xff;
  machine.y = end >>> 8;
  machine.flag(1, false);

  // JSR leaves the address of its final operand on the descending CPU stack.
  // LOAD returns to the following instruction, just as RTS would.
  const returnAddress = machine.pop() | (machine.pop() << 8);
  machine.pc = (returnAddress + 1) & 0xffff;
  machine.cycles += 60;
  machine.instructions += 12; // Functional service accounting, not disk timing.

  return {
    name,
    mediaHash: file.mediaHash,
    fileId: file.fileId,
    start,
    end,
    bytes: payload.length,
    secondary: secondaryAddress,
  };
}
