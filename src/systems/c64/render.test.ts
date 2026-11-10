import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { renderC64, type VideoSnapshot } from './render.js';
import { encodePng } from '../../png.js';
import { AddressSpace } from '../../memory.js';
import { C64SystemBus } from './system.js';
import { C64RasterDisplay } from './raster.js';
import { C64Player } from './player.js';
import { captureC64 } from './snapshot.js';
import { Machine } from '../../runtime/mos6502.js';
import { disassemble } from '../../transpiler/mos6502.js';
import { lift } from '../../transpiler/lift.js';

function fixture(): VideoSnapshot {
  const video = {
    ram: new Uint8Array(65536),
    known: new Uint8Array(65536).fill(1),
    colour: new Uint8Array(1024).fill(2),
    registers: new Uint8Array(64),
    bank: 0,
  };
  video.registers[0x11] = 0x1b;
  video.registers[0x16] = 8;
  video.registers[0x18] = 0x18;
  video.registers[0x21] = 1;
  video.ram.fill(1, 0x400, 0x7e8);
  video.ram[0x2008] = 0x80;
  return video;
}
const pixel = (bytes: Uint8Array, x: number, y: number): number[] => [
  ...bytes.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4),
];
test('character pixels use recovered glyphs and cell colours, and reject absent character ROM', () => {
  const video = fixture(),
    pixels = renderC64(video);
  assert.deepEqual(pixel(pixels, 0, 0), [0x68, 0x37, 0x2b, 255]);
  assert.deepEqual(pixel(pixels, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(pixels, 0, 1), [255, 255, 255, 255]);
  video.known[0x2008] = 0;
  assert.throws(() => renderC64(video), /unrecovered RAM/);
  video.known[0x2008] = 1;
  video.registers[0x18] = 0x14;
  assert.throws(() => renderC64(video), /Character ROM is required/);
});
test('bitmap rows use C64 cell interleaving and sprites respect background priority', () => {
  const video = fixture();
  video.registers[0x11] = 0x3b;
  video.ram.fill(0xf0, 0x400, 0x7e8);
  video.ram[0x2000] = 0x80;
  video.ram[0x2140] = 0x80;
  let pixels = renderC64(video);
  assert.deepEqual(pixel(pixels, 0, 0), [149, 149, 149, 255]);
  assert.deepEqual(pixel(pixels, 0, 8), [149, 149, 149, 255]);
  assert.deepEqual(pixel(pixels, 1, 8), [0, 0, 0, 255]);
  video.registers[0x15] = 1;
  video.registers[0] = 24;
  video.registers[1] = 50;
  video.registers[0x27] = 7;
  video.ram[0x7f8] = 0x30;
  video.ram[0xc00] = 0x80;
  pixels = renderC64(video);
  assert.deepEqual(pixel(pixels, 0, 0), [184, 199, 111, 255]);
  video.registers[0x1b] = 1;
  pixels = renderC64(video);
  assert.deepEqual(pixel(pixels, 0, 0), [149, 149, 149, 255]);
});
for (const scroll of [1, 3, 4, 7]) {
  test(`horizontal fine scroll ${scroll} moves characters while sprite coordinates stay fixed`, () => {
    const video = fixture(),
      r = video.registers;
    r[0x16] = 8 | scroll;
    r[0x15] = 1;
    r[0] = 26;
    r[1] = 50;
    r[0x27] = 7;
    video.ram[0x7f8] = 0x30;
    video.ram[0xc00] = 0x80;
    const pixels = renderC64(video);
    for (let x = 0; x < 20; x++) {
      const expected =
        x === 2
          ? [184, 199, 111, 255]
          : x >= scroll && (x - scroll) % 8 === 0
            ? [104, 55, 43, 255]
            : [255, 255, 255, 255];
      assert.deepEqual(pixel(pixels, x, 0), expected, `x=${x}`);
    }
  });
}
test('odd horizontal fine scroll moves multicolour pairs, retained columns and sprite priority together', () => {
  const video = fixture(),
    r = video.registers;
  r[0x16] = 0x1b;
  r[0x22] = 2;
  r[0x23] = 3;
  video.colour.fill(9);
  r[0x15] = 1;
  r[0x1b] = 1;
  r[0] = 24;
  r[1] = 50;
  r[0x27] = 7;
  video.ram[0x7f8] = 0x30;
  video.ram[0xc00] = 0xff;
  const characters = new Uint8Array(40).fill(1),
    colours = new Uint8Array(40).fill(9);
  video.ram[0x2008] = 0x60; // Background 01 at x=3,4; foreground 10 at x=5,6.
  const pixels = new Uint8Array(320 * 200 * 4),
    foreground = new Uint8Array(320 * 200);
  renderC64(video, {
    start: 0,
    end: 1,
    pixels,
    foreground,
    characterLine: { characters, colours, row: 0, base: 0, active: true },
  });
  for (let x = 0; x < 8; x++) {
    assert.deepEqual(
      pixel(pixels, x, 0),
      x === 5 || x === 6 ? [112, 164, 178, 255] : [184, 199, 111, 255],
      `x=${x}`,
    );
  }
  assert.deepEqual([...foreground.subarray(0, 8)], [0, 0, 0, 0, 0, 1, 1, 0]);
});
test('blanked VIC does not require recovered display memory, and PNG chunks decode with valid CRCs', () => {
  const video = fixture();
  video.registers[0x11] = 0x60;
  video.known.fill(0);
  const png = encodePng(320, 200, renderC64(video));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8,
    decoded: Buffer | undefined;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset),
      kind = png.toString('ascii', offset + 4, offset + 8),
      data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      png.readUInt32BE(offset + 8 + length),
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    if (kind === 'IDAT') {
      decoded = inflateSync(data);
    }
    offset += length + 12;
  }
  assert.equal(decoded!.length, 200 * (320 * 4 + 1));
  assert.equal(decoded![4], 255);
});

const BLACK = [0, 0, 0, 255],
  WHITE = [255, 255, 255, 255];
function rasterFixture() {
  const bus = new C64SystemBus(new AddressSpace());
  bus.known.fill(1);
  bus.bytes.fill(0);
  bus.cia2.registers[0] = 2; // VIC bank $4000, screen $4400, RAM characters $6000.
  bus.vic.registers[0x18] = 0x18;
  const display = new C64RasterDisplay(bus);
  const until = (line: number, cycle = 63): void => {
    const target = line * 63 + cycle - 1;
    while (bus.clock < target) {
      bus.advanceTo(Math.min(target, bus.clock + 4));
      display.capture(bus);
    }
  };
  return { bus, display, until };
}

// These expected pixels are constructed from a 21-row image, independently of
// the renderer. Comparing two executions of renderC64 would miss shared bugs.
for (const sprite of [0, 3, 7]) {
  test(`sprite ${sprite} finishes all 21 rows after an early Y write, then reuses the new pointer`, () => {
    const { bus, display, until } = rasterFixture(),
      r = bus.vic.registers,
      mask = 1 << sprite;
    r[0x15] = mask;
    r[sprite * 2] = 24;
    r[sprite * 2 + 1] = 51;
    r[0x27 + sprite] = 1;
    bus.bytes[0x47f8 + sprite] = 0xc0;
    for (let row = 0; row < 21; row++) {
      bus.bytes[0x7000 + row * 3] = 0x80 >>> (row & 7);
      bus.bytes[0x7040 + row * 3 + 2] = 0x80;
    }
    until(61, 20);
    r[sprite * 2 + 1] = 72;
    r[0x15] = 0;
    // A pointer write after the final row's fetch must not change latched data.
    until(sprite === 0 ? 71 : 72, sprite === 0 ? 60 : 12);
    bus.bytes[0x47f8 + sprite] = 0xc1;
    r[0x15] = mask;
    until(95);
    for (let row = 0; row < 21; row++) {
      for (let x = 0; x < 24; x++) {
        assert.deepEqual(
          pixel(display.pixels, x, row + 1),
          x === (row & 7) ? WHITE : BLACK,
          `old row ${row}, x ${x}`,
        );
        assert.deepEqual(
          pixel(display.pixels, x, row + 22),
          x === 16 ? WHITE : BLACK,
          `reused row ${row}, x ${x}`,
        );
      }
    }
    assert.deepEqual(pixel(display.pixels, 16, 43), BLACK);
  });
}

test('Y expansion repeats each of the 21 fetched sprite rows twice', () => {
  const { bus, display, until } = rasterFixture(),
    r = bus.vic.registers;
  r[0x15] = 1;
  r[0x17] = 1;
  r[0] = 24;
  r[1] = 51;
  r[0x27] = 1;
  bus.bytes[0x47f8] = 0xc0;
  for (let row = 0; row < 21; row++) {
    bus.bytes[0x7000 + row * 3] = 0x80 >>> (row & 7);
  }
  until(96);
  for (let row = 0; row < 42; row++) {
    for (let x = 0; x < 8; x++) {
      assert.deepEqual(pixel(display.pixels, x, row + 1), x === ((row >>> 1) & 7) ? WHITE : BLACK);
    }
  }
  assert.deepEqual(pixel(display.pixels, 4, 43), BLACK);
});

test('character and colour rows remain latched while glyph-bank changes take effect', () => {
  const { bus, display, until } = rasterFixture(),
    r = bus.vic.registers;
  bus.bytes[0x4400] = 1;
  bus.colour[0] = 2;
  bus.bytes.fill(0x80, 0x6008, 0x6010);
  bus.bytes.fill(0x40, 0x6808, 0x6810);
  bus.bytes.fill(0x20, 0x6810, 0x6818);
  until(52, 20);
  bus.bytes.fill(2, 0x4400, 0x47e8);
  bus.colour.fill(5);
  until(54, 20);
  r[0x18] = 0x1a;
  until(60);
  for (let row = 0; row < 4; row++) {
    assert.deepEqual(pixel(display.pixels, 0, row), [104, 55, 43, 255]);
  }
  for (let row = 4; row < 8; row++) {
    assert.deepEqual(pixel(display.pixels, 0, row), BLACK);
    assert.deepEqual(pixel(display.pixels, 1, row), [104, 55, 43, 255]);
  }
  assert.deepEqual(pixel(display.pixels, 2, 8), [88, 141, 67, 255]);
});

test('multicolour 01 is background, and a hidden lower-numbered sprite still wins sprite priority', () => {
  const video = fixture(),
    r = video.registers;
  r[0x16] = 0x18;
  r[0x22] = 2;
  r[0x23] = 3;
  video.colour.fill(9);
  video.ram[0x2008] = 0x60; // 01, 10, 00, 00.
  r[0x15] = 3;
  r[0x1b] = 1;
  for (let sprite = 0; sprite < 2; sprite++) {
    r[sprite * 2] = 24;
    r[sprite * 2 + 1] = 50;
    r[0x27 + sprite] = 7 + sprite;
    video.ram[0x7f8 + sprite] = 0x30 + sprite;
    video.ram[0xc00 + sprite * 64] = 0xf0;
  }
  const pixels = renderC64(video);
  assert.deepEqual(pixel(pixels, 0, 0), [184, 199, 111, 255]); // Sprite 0 covers background 01.
  assert.deepEqual(pixel(pixels, 2, 0), [112, 164, 178, 255]); // Foreground 10 hides sprite 0 and sprite 1.
});

test('PAL read-ready windows include badline lead-in and sprite DMA across the line boundary', () => {
  const a = rasterFixture();
  a.until(51, 11);
  assert.equal(a.display.cpuReadBlocked(a.bus), false);
  a.until(51, 12);
  assert.equal(a.display.cpuReadBlocked(a.bus), true);
  a.until(51, 54);
  assert.equal(a.display.cpuReadBlocked(a.bus), true);
  a.until(51, 55);
  assert.equal(a.display.cpuReadBlocked(a.bus), false);
  for (const sprite of [0, 3]) {
    const b = rasterFixture(),
      r = b.bus.vic.registers;
    r[0x15] = 1 << sprite;
    r[sprite * 2 + 1] = 51;
    b.bus.bytes[0x47f8 + sprite] = 0xc0;
    if (sprite === 0) {
      b.until(60, 54);
      assert.equal(b.display.cpuReadBlocked(b.bus), false);
      b.until(60, 55);
      assert.equal(b.display.cpuReadBlocked(b.bus), true);
      b.until(60, 60);
      assert.equal(b.display.cpuReadBlocked(b.bus), false);
    } else {
      b.until(60, 61);
      assert.equal(b.display.cpuReadBlocked(b.bus), true);
      b.until(61, 2);
      assert.equal(b.display.cpuReadBlocked(b.bus), true);
      b.until(61, 3);
      assert.equal(b.display.cpuReadBlocked(b.bus), false);
    }
  }
});

for (const sprite of [0, 3, 7]) {
  test(`clocked pointer INC preserves sprite ${sprite}'s final row before adjacent reuse`, async () => {
    const { bus } = rasterFixture(),
      r = bus.vic.registers;
    bus.write(1, 0x35);
    r[0x15] = 255;
    for (let index = 0; index < 8; index++) {
      r[index * 2] = 24 + index * 24;
      r[index * 2 + 1] = 51;
      r[0x27 + index] = 1;
      bus.bytes[0x47f8 + index] = 0xc0;
    }
    for (let row = 0; row < 21; row++) {
      bus.bytes[0x7000 + row * 3] = 0x80;
      bus.bytes[0x7040 + row * 3] = 0x40;
    }
    const pointer = 0x47f8 + sprite,
      yRegister = 0xd001 + sprite * 2;
    // Wait for line 71, then approach the late DMA window. Hardware RDY holds
    // reads until all old row-20 fetches finish; INC then changes the pointer.
    const code = [
      0xad,
      0x12,
      0xd0,
      0xc9,
      71,
      0xd0,
      0xf9,
      ...Array<number>(24).fill(0xea),
      0xee,
      pointer & 255,
      pointer >>> 8,
      0xa9,
      72,
      0x8d,
      yRegister & 255,
      yRegister >>> 8,
    ];
    const stop = 0x8000 + code.length;
    code.push(0x4c, stop & 255, stop >>> 8);
    bus.bytes.set(code, 0x8000);
    const space = new AddressSpace();
    space.bytes.set(bus.bytes);
    space.loaded.set(bus.known);
    const emitted = lift(disassemble(space, [0x8000]).instructions);
    const { step } = (await import(
      `data:text/javascript;base64,${Buffer.from(emitted.javascript).toString('base64')}`
    )) as { step(machine: Machine): void };
    const machine = new Machine(bus);
    machine.pc = 0x8000;
    const player = new C64Player(captureC64(bus, machine), step, () => 0, {
      controlAddress: 0xffff,
      applyInput: () => {},
    });
    player.advanceFrame();
    assert.equal(player.gap, undefined);
    const x = sprite * 24;
    for (let row = 0; row < 21; row++) {
      assert.deepEqual(pixel(player.display.pixels, x, row + 1), WHITE, `old row ${row}`);
      assert.deepEqual(pixel(player.display.pixels, x + 1, row + 1), BLACK, `old row ${row}`);
      assert.deepEqual(pixel(player.display.pixels, x, row + 22), BLACK, `reused row ${row}`);
      assert.deepEqual(pixel(player.display.pixels, x + 1, row + 22), WHITE, `reused row ${row}`);
    }
  });
}

test('raster row composition agrees with the full snapshot and clears stale foreground on blanked rows', () => {
  const ram = new Uint8Array(65536),
    known = new Uint8Array(65536).fill(1),
    colour = new Uint8Array(1024).fill(1),
    registers = new Uint8Array(64);
  registers[0x11] = 0x1b;
  registers[0x16] = 8;
  registers[0x18] = 0x14;
  ram.fill(1, 0x4400, 0x47e8);
  ram.fill(0xaa, 0x5008, 0x5010);
  const video = { ram, known, colour, registers, bank: 0x4000 },
    pixels = new Uint8Array(320 * 200 * 4),
    foreground = new Uint8Array(320 * 200);
  const full = renderC64(video);
  for (let y = 0; y < 200; y++) {
    renderC64(video, { start: y, end: y + 1, pixels, foreground });
  }
  assert.deepEqual(pixels, full);
  registers[0x11] = 0;
  renderC64(video, { start: 0, end: 1, pixels, foreground });
  assert.ok(foreground.subarray(0, 320).every((value) => value === 0));
});
