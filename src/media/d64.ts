import {
  Diagnostic,
  sha256,
  type ExtractedFile,
  type MediaEntry,
  type MediaImage,
  type MediaReader,
} from '../core.js';

export const sectorsOnTrack = (track: number): number =>
  track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
function geometry(size: number): { tracks: number; sectors: number; errors: boolean } | undefined {
  for (const tracks of [35, 40, 42]) {
    let sectors = 0;
    for (let t = 1; t <= tracks; t++) {
      sectors += sectorsOnTrack(t);
    }
    if (size === sectors * 256 || size === sectors * 257) {
      return { tracks, sectors, errors: size === sectors * 257 };
    }
  }
  return undefined;
}
export function petscii(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end && (bytes[end - 1] === 0xa0 || bytes[end - 1] === 0)) {
    end--;
  }
  return [...bytes.subarray(0, end)]
    .map((b) => {
      if (b >= 0xc1 && b <= 0xda) {
        return String.fromCharCode(b - 0x80);
      }
      return b >= 0x20 && b <= 0x7e
        ? String.fromCharCode(b)
        : `\\x${b.toString(16).padStart(2, '0')}`;
    })
    .join('');
}

export class D64Image implements MediaImage {
  readonly hash: string;
  readonly name: string;
  readonly diskId: string;
  readonly entries: MediaEntry[] = [];
  readonly tracks: number;
  readonly sectorCount: number;
  readonly hasErrors: boolean;
  private readonly bytes: Uint8Array;
  private readonly directorySectors = new Set<number>();
  constructor(input: Uint8Array) {
    const layout = geometry(input.length);
    if (!layout) {
      throw new Diagnostic(
        'D64_GEOMETRY',
        `Unsupported D64 size ${input.length}; expected a 35, 40 or 42 track image, optionally with error bytes.`,
      );
    }
    this.bytes = input.slice();
    this.hash = sha256(this.bytes);
    this.tracks = layout.tracks;
    this.sectorCount = layout.sectors;
    this.hasErrors = layout.errors;
    const bam = this.sector(18, 0);
    this.directorySectors.add(this.offset(18, 0));
    this.name = petscii(bam.subarray(0x90, 0xa0));
    this.diskId = petscii(bam.subarray(0xa2, 0xa4));
    let track = bam[0]!,
      sector = bam[1]!;
    if (track === 0) {
      throw new Diagnostic('D64_DIRECTORY', 'BAM has no directory link.');
    }
    while (track) {
      const offset = this.offset(track, sector);
      if (this.directorySectors.has(offset)) {
        throw new Diagnostic('D64_DIRECTORY_LOOP', `Directory cycle at ${track}/${sector}.`);
      }
      this.directorySectors.add(offset);
      const data = this.sector(track, sector);
      for (let slot = 0; slot < 8; slot++) {
        const p = slot * 32;
        const flags = data[p + 2]!;
        if (flags === 0) {
          continue;
        }
        const type = (['DEL', 'SEQ', 'PRG', 'USR', 'REL'] as const)[flags & 7];
        if (!type) {
          throw new Diagnostic(
            'D64_FILE_TYPE',
            `Unknown file type ${flags & 7} at directory offset ${offset + p + 2}.`,
          );
        }
        this.entries.push({
          id: `entry-${this.entries.length.toString().padStart(3, '0')}`,
          name: petscii(data.subarray(p + 5, p + 21)),
          type,
          closed: !!(flags & 0x80),
          locked: !!(flags & 0x40),
          blocks: data[p + 30]! | (data[p + 31]! << 8),
          start: { track: data[p + 3]!, sector: data[p + 4]! },
          directoryOffset: offset + p + 2,
        });
      }
      track = data[0]!;
      sector = data[1]!;
    }
  }
  offset(track: number, sector: number): number {
    if (
      !Number.isInteger(track) ||
      !Number.isInteger(sector) ||
      track < 1 ||
      track > this.tracks ||
      sector < 0 ||
      sector >= sectorsOnTrack(track)
    ) {
      throw new Diagnostic(
        'D64_SECTOR_RANGE',
        `Invalid track/sector ${track}/${sector} for ${this.tracks} tracks.`,
      );
    }
    let preceding = 0;
    for (let t = 1; t < track; t++) {
      preceding += sectorsOnTrack(t);
    }
    return (preceding + sector) * 256;
  }
  sector(track: number, sector: number): Uint8Array {
    const offset = this.offset(track, sector);
    if (this.hasErrors) {
      const status = this.bytes[this.sectorCount * 256 + offset / 256]!;
      if (status !== 1) {
        throw new Diagnostic(
          'D64_SECTOR_ERROR',
          `Track/sector ${track}/${sector} has recorded error ${status}.`,
        );
      }
    }
    return this.bytes.slice(offset, offset + 256);
  }
  extract(entry: MediaEntry): ExtractedFile {
    if (!this.entries.includes(entry)) {
      throw new Diagnostic('D64_ENTRY', 'Entry does not belong to this disk.');
    }
    if (entry.type === 'REL') {
      throw new Diagnostic('D64_REL_UNSUPPORTED', 'Relative files need a side-sector reader.');
    }
    const spans: ExtractedFile['spans'] = [],
      chunks: Uint8Array[] = [],
      visited = new Set<number>();
    let { track, sector } = entry.start,
      length = 0;
    while (track) {
      const offset = this.offset(track, sector);
      if (visited.has(offset)) {
        throw new Diagnostic(
          'D64_CHAIN_LOOP',
          `File '${entry.name}' repeats sector ${track}/${sector}.`,
        );
      }
      if (this.directorySectors.has(offset)) {
        throw new Diagnostic(
          'D64_CHAIN_METADATA',
          `File '${entry.name}' links into disk metadata.`,
        );
      }
      visited.add(offset);
      const data = this.sector(track, sector);
      const count = data[0] === 0 ? data[1]! - 1 : 254;
      if (count < 0 || count > 254) {
        throw new Diagnostic('D64_LAST_SECTOR', `Invalid final byte count at ${track}/${sector}.`);
      }
      chunks.push(data.slice(2, 2 + count));
      spans.push({
        mediaHash: this.hash,
        fileId: entry.id,
        fileOffset: length,
        mediaOffset: offset + 2,
        length: count,
        track,
        sector,
      });
      length += count;
      track = data[0]!;
      sector = data[1]!;
    }
    const bytes = new Uint8Array(length);
    let p = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, p);
      p += chunk.length;
    }
    return { bytes, spans };
  }
}

export const d64Reader: MediaReader = {
  format: 'd64',
  version: '1',
  probe(bytes) {
    const layout = geometry(bytes.length);
    if (!layout) {
      return undefined;
    }
    try {
      const image = new D64Image(bytes);
      return {
        confidence: 0.8,
        evidence: [
          `${layout.tracks} tracks / ${layout.sectors} sectors`,
          `Valid directory: ${image.entries.length} entries`,
          'D64 geometry is shared by Commodore systems; system requires a recipe or override.',
        ],
      };
    } catch {
      return {
        confidence: 0.2,
        evidence: ['D64-sized input with invalid directory or recorded sector errors'],
      };
    }
  },
  open: (bytes) => new D64Image(bytes),
};
