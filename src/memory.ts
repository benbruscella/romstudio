import { Diagnostic, type SourceSpan } from './contracts.js';

export interface LocationSource {
  mediaHash: string;
  fileId: string;
  fileOffset: number;
  mediaOffset: number;
  epoch: number;
  bank: string;
  relocatedFrom?: number;
}
export class AddressSpace {
  readonly bytes = new Uint8Array(65536);
  readonly loaded = new Uint8Array(65536);
  private readonly provenance = new Map<number, LocationSource>();
  epoch = 0;
  loadPrg(prg: Uint8Array, spans: SourceSpan[] = []): { start: number; end: number } {
    if (prg.length < 2) {
      throw new Diagnostic('PRG_HEADER', 'PRG must contain a two-byte load address.');
    }
    const start = prg[0]! | (prg[1]! << 8),
      size = prg.length - 2;
    if (start + size > 65536) {
      throw new Diagnostic('PRG_OVERFLOW', 'PRG extends beyond the 16-bit address space.');
    }
    this.bytes.set(prg.subarray(2), start);
    this.loaded.fill(1, start, start + size);
    for (const span of spans) {
      for (let p = Math.max(2, span.fileOffset); p < span.fileOffset + span.length; p++) {
        const address = start + p - 2;
        this.provenance.set(address, {
          mediaHash: span.mediaHash,
          fileId: span.fileId,
          fileOffset: p,
          mediaOffset: span.mediaOffset + p - span.fileOffset,
          epoch: this.epoch,
          bank: 'ram',
        });
      }
    }
    return { start, end: start + size };
  }
  relocate(source: number, destination: number, length: number): void {
    if (
      ![source, destination, length].every(Number.isInteger) ||
      length < 0 ||
      source < 0 ||
      destination < 0 ||
      source + length > 65536 ||
      destination + length > 65536
    ) {
      throw new Diagnostic('MEMORY_RANGE', 'Relocation exceeds the address space.');
    }
    const data = this.bytes.slice(source, source + length);
    const origins = Array.from({ length }, (_, i) => this.source(source + i));
    this.epoch++;
    this.bytes.set(data, destination);
    this.loaded.fill(1, destination, destination + length);
    for (let i = 0; i < length; i++) {
      const origin = origins[i];
      if (origin) {
        this.provenance.set(destination + i, {
          ...origin,
          relocatedFrom: source + i,
          epoch: this.epoch,
        });
      } else {
        this.provenance.delete(destination + i);
      }
    }
  }
  source(address: number): LocationSource | undefined {
    return this.provenance.get(address);
  }
}
