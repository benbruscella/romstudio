import { Diagnostic } from '../contracts.js';

export type N64ByteOrder = 'big-endian' | 'byte-swapped-16' | 'word-swapped-32';
const signatures: Readonly<Record<number, N64ByteOrder>> = {
  0x80371240: 'big-endian',
  0x37804012: 'byte-swapped-16',
  0x40123780: 'word-swapped-32',
};
export function n64ByteOrder(bytes: Uint8Array): N64ByteOrder | undefined {
  if (bytes.length < 4) {
    return undefined;
  }
  return signatures[
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  ];
}

/** Normalize a cartridge dump for big-endian MIPS reads without changing the
 * original file. The raw-image hash remains separate from its canonical hash. */
export function readN64Rom(bytes: Uint8Array) {
  const byteOrder = n64ByteOrder(bytes);
  if (!byteOrder) {
    throw new Diagnostic('N64_MAGIC', 'Unrecognised N64 cartridge byte-order signature.');
  }
  if (bytes.length < 0x1000 || bytes.length % 4 !== 0 || bytes.length > 67108864) {
    throw new Diagnostic(
      'N64_LENGTH',
      'Expected a word-aligned N64 image with its 4 KiB header/boot area, at most 64 MiB.',
    );
  }
  const rom = new Uint8Array(bytes.length);
  const mask = byteOrder === 'byte-swapped-16' ? 1 : byteOrder === 'word-swapped-32' ? 3 : 0;
  for (let index = 0; index < bytes.length; index++) {
    rom[index] = bytes[index ^ mask]!;
  }
  const view = new DataView(rom.buffer);
  const text = (start: number, length: number) =>
    String.fromCharCode(...rom.subarray(start, start + length))
      .replace(/\0/g, '')
      .trimEnd();
  return {
    rom,
    byteOrder,
    header: {
      title: text(0x20, 20),
      gameCode: text(0x3b, 4),
      countryCode: String.fromCharCode(rom[0x3e]!),
      revision: rom[0x3f]!,
      entryPoint: view.getUint32(8, false),
      clockRateSetting: view.getUint32(4, false),
      releaseCode: view.getUint32(12, false),
      crc1: view.getUint32(16, false),
      crc2: view.getUint32(20, false),
    },
  };
}
