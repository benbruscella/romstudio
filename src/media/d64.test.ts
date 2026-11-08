import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D64Image, d64Reader, sectorsOnTrack, petscii } from './d64.js';
import { AddressSpace } from '../memory.js';
import { basicSys } from './basic.js';

function fixture(): { bytes: Uint8Array; offset: (track: number, sector: number) => number } {
  const bytes = new Uint8Array(174848);
  const offset = (track: number, sector: number): number => {
    let n = sector;
    for (let t = 1; t < track; t++) {
      n += sectorsOnTrack(t);
    }
    return n * 256;
  };
  const bam = offset(18, 0),
    directory = offset(18, 1),
    file = offset(1, 0);
  bytes[bam] = 18;
  bytes[bam + 1] = 1;
  bytes.fill(0xa0, bam + 0x90, bam + 0xa0);
  bytes.set(Buffer.from('TEST'), bam + 0x90);
  bytes[directory + 1] = 255;
  bytes[directory + 2] = 0x82;
  bytes[directory + 3] = 1;
  bytes.fill(0xa0, directory + 5, directory + 21);
  bytes.set(Buffer.from('../BOOT'), directory + 5);
  bytes[directory + 30] = 1;
  bytes[file + 1] = 5;
  bytes.set([1, 8, 0xaa, 0xbb], file + 2);
  return { bytes, offset };
}
test('D64 extracts exact terminal byte count and physical provenance', () => {
  const { bytes } = fixture(),
    disk = new D64Image(bytes);
  assert.equal(disk.name, 'TEST');
  assert.equal(disk.entries[0]!.name, '../BOOT');
  const file = disk.extract(disk.entries[0]!);
  assert.deepEqual([...file.bytes], [1, 8, 0xaa, 0xbb]);
  assert.equal(file.spans[0]!.mediaOffset, 2);
  assert.equal(file.spans[0]!.length, 4);
  bytes[2] = 0;
  assert.equal(disk.extract(disk.entries[0]!).bytes[0], 1);
  assert.equal(petscii(Uint8Array.from([0xc1, 0x22, 0x01, 0xa0])), 'A"\\x01');
});
test('D64 traverses multiple sectors and supports full 254-byte final sectors', () => {
  const { bytes } = fixture();
  bytes[0] = 1;
  bytes[1] = 1;
  bytes[256] = 0;
  bytes[257] = 255;
  bytes[511] = 0x7f;
  const disk = new D64Image(bytes),
    file = disk.extract(disk.entries[0]!);
  assert.equal(file.bytes.length, 508);
  assert.equal(file.bytes[507], 0x7f);
  assert.equal(file.spans[1]!.fileOffset, 254);
  assert.equal(file.spans[1]!.mediaOffset, 258);
});
test('D64 bounds invalid geometry, sector numbers and cyclic chains', () => {
  assert.throws(() => new D64Image(new Uint8Array(42)), /Unsupported D64 size/);
  const { bytes } = fixture();
  bytes[0] = 1;
  bytes[1] = 0;
  const disk = new D64Image(bytes);
  assert.throws(() => disk.extract(disk.entries[0]!), /repeats sector/);
  assert.throws(() => disk.sector(36, 0), /Invalid track/);
  assert.throws(() => disk.sector(18, 19), /Invalid track/);
  bytes[1] = 21;
  const invalid = new D64Image(bytes);
  assert.throws(() => invalid.extract(invalid.entries[0]!), /Invalid track/);
});
test('directory cycles, links into metadata, bad terminal counts and disk errors fail explicitly', () => {
  const { bytes, offset } = fixture();
  const directory = offset(18, 1);
  bytes[directory] = 18;
  bytes[directory + 1] = 1;
  assert.throws(() => new D64Image(bytes), /Directory cycle/);
  bytes[directory] = 0;
  bytes[directory + 3] = 18;
  bytes[directory + 4] = 0;
  const disk = new D64Image(bytes);
  assert.throws(() => disk.extract(disk.entries[0]!), /metadata/);
  bytes[directory + 3] = 1;
  bytes[1] = 0;
  const badEnd = new D64Image(bytes);
  assert.throws(() => badEnd.extract(badEnd.entries[0]!), /final byte count/);
  const withErrors = new Uint8Array(175531);
  withErrors.set(bytes);
  withErrors.fill(1, 174848);
  withErrors[174848 + offset(18, 0) / 256] = 5;
  assert.throws(() => new D64Image(withErrors), /recorded error 5/);
});
test('geometry detection avoids asserting that every D64 is a C64 title', () => {
  assert.equal(d64Reader.probe(new Uint8Array(100)), undefined);
  assert.equal(d64Reader.probe(fixture().bytes)?.confidence, 0.8);
  for (const size of [196608, 197376, 205312, 206114]) {
    const bytes = new Uint8Array(size);
    bytes.set(fixture().bytes);
    assert.ok(d64Reader.probe(bytes));
  }
});
test('PRG loading and relocation preserve original file/sector offsets across epochs', () => {
  const disk = new D64Image(fixture().bytes),
    file = disk.extract(disk.entries[0]!);
  const space = new AddressSpace();
  assert.deepEqual(space.loadPrg(file.bytes, file.spans), { start: 0x801, end: 0x803 });
  assert.equal(space.source(0x801)!.fileOffset, 2);
  assert.equal(space.source(0x801)!.mediaOffset, 4);
  space.relocate(0x801, 0x340, 2);
  assert.equal(space.bytes[0x340], 0xaa);
  assert.equal(space.source(0x340)!.mediaOffset, 4);
  assert.equal(space.source(0x340)!.epoch, 1);
  assert.equal(space.source(0x340)!.relocatedFrom, 0x801);
  assert.throws(() => space.loadPrg(Uint8Array.from([255, 255, 0, 0])), /beyond/);
  assert.throws(() => space.loadPrg(new Uint8Array(1)), /two-byte/);
});
test('BASIC SYS entry resolves automatically without BASIC or a LOAD prompt', () => {
  const memory = new Uint8Array(65536);
  memory.set([0x0c, 8, 0xc9, 7, 0x9e, 0xff, 0xac, 0x36, 0x35, 0x36, 0, 0, 0], 0x801);
  assert.equal(basicSys(memory, 0x801).entry, 0x80c);
  memory.set([0x0d, 8, 1, 0, 0x9e, 0x32, 0x30, 0x36, 0x30, 0, 0, 0, 0, 0], 0x801);
  assert.equal(basicSys(memory, 0x801).entry, 2060);
  memory[0x802] = 0;
  assert.throws(() => basicSys(memory, 0x801), /outside/);
});
