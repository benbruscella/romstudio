import { Diagnostic, sha256, type MediaReader } from '../core.js';
import { NesCartridge, type CartridgeData, type Mirroring } from '../systems/nes/cartridge.js';
export interface NesMedia {
  format: 'ines' | 'raw-nes-chips';
  cartridge: CartridgeData;
  identity: { role: string; bytes: number; sha256: string }[];
}
export function rawNesChips(
  prg: Uint8Array,
  chr: Uint8Array,
  board: { mapper: number; mirroring: Mirroring },
): NesMedia {
  const cartridge = { ...board, prg, chr };
  new NesCartridge(cartridge);
  return {
    format: 'raw-nes-chips',
    cartridge,
    identity: [
      { role: 'prg', bytes: prg.length, sha256: sha256(prg) },
      { role: 'chr', bytes: chr.length, sha256: sha256(chr) },
    ],
  };
}
export function readInes(bytes: Uint8Array): NesMedia {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x4e ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x53 ||
    bytes[3] !== 0x1a
  ) {
    throw new Diagnostic('INES_HEADER', 'Expected an iNES header.');
  }
  if ((bytes[7]! & 12) === 8) {
    throw new Diagnostic('NES2_HEADER', 'NES 2.0 headers require an additional format adapter.');
  }
  if (bytes[6]! & 4) {
    throw new Diagnostic(
      'INES_TRAINER',
      'Trainer mapping at $7000 requires an additional launch adapter.',
    );
  }
  if (bytes[6]! & 8) {
    throw new Diagnostic('INES_FOUR_SCREEN', 'Four-screen nametable boards are unsupported.');
  }
  const prgSize = bytes[4]! * 16384,
    chrSize = bytes[5]! * 8192,
    start = 16 + (bytes[6]! & 4 ? 512 : 0);
  if (bytes.length !== start + prgSize + chrSize) {
    throw new Diagnostic('INES_LENGTH', 'Chip lengths do not match the header.');
  }
  const result = rawNesChips(bytes.slice(start, start + prgSize), bytes.slice(start + prgSize), {
    mapper: (bytes[6]! >>> 4) | (bytes[7]! & 0xf0),
    mirroring: bytes[6]! & 1 ? 'vertical' : 'horizontal',
  });
  return { ...result, format: 'ines' };
}
export const inesReader: MediaReader<NesMedia> = {
  format: 'ines',
  version: '1',
  probe: (bytes) =>
    bytes.length >= 16 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a
      ? {
          confidence: 1,
          evidence: ['iNES signature; mapper and chip sizes still require validation.'],
        }
      : undefined,
  open: readInes,
};
