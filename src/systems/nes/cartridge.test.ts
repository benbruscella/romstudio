import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NesCartridge } from './cartridge.js';
const board = (mapper = 0) => {
  const prg = new Uint8Array(32768),
    chr = new Uint8Array(16384);
  prg.fill(1, 0, 16384);
  prg.fill(2, 16384);
  for (let i = 0; i < 4; i++) {
    chr.fill(10 + i, i * 4096, (i + 1) * 4096);
  }
  return new NesCartridge({
    mapper,
    mirroring: 'vertical',
    prg,
    chr: mapper ? chr : chr.slice(0, 8192),
  });
};
test('NROM maps chips and physical vertical nametable wiring', () => {
  const c = board();
  assert.equal(c.readCpu(0x8000), 1);
  assert.equal(c.readCpu(0xffff), 2);
  assert.equal(c.readChr(0x1000), 11);
  assert.deepEqual(
    [0x2000, 0x2400, 0x2800, 0x2c00].map((a) => c.nametableOffset(a)),
    [0, 1024, 0, 1024],
  );
  c.writeCpu(0x8000, 3, 0);
  assert.equal(c.readCpu(0x8000), 1);
});
test('MMC1 commits five serial bits, switches PRG/CHR and ignores consecutive RMW data writes', () => {
  const c = board(1);
  let cycle = 0;
  const write = (address: number, value: number) => {
    for (let bit = 0; bit < 5; bit++) {
      c.writeCpu(address, (value >>> bit) & 1, cycle);
      cycle += 3;
    }
  };
  write(0xe000, 1);
  assert.equal(c.readCpu(0x8000), 2);
  write(0x8000, 0x1e);
  write(0xa000, 2);
  write(0xc000, 3);
  assert.equal(c.readChr(0), 12);
  assert.equal(c.readChr(0x1000), 13);
  c.writeCpu(0x8000, 128, 100);
  c.writeCpu(0x8000, 1, 104);
  const shifted = c.registers.shift;
  c.writeCpu(0x8000, 0, 105);
  assert.equal(c.registers.shift, shifted);
  c.writeCpu(0x8000, 128, 106);
  assert.equal(c.registers.shift, 16);
});
