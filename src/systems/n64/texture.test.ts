import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Texture, type N64Tile } from './texture.js';

function fixture() {
  return new N64Texture((kind, message) => {
    throw new Error(`${kind}: ${message}`);
  });
}

test('RDP image and tile fields retain fixed-point bounds and independent render/load descriptors', () => {
  const texture = fixture();
  texture.setImage(0xfd100fff, 0xff123456);
  assert.deepEqual(texture.image, { format: 0, size: 2, width: 1024, address: 0x3123456 });
  texture.setTile(0xf5100000, 0x07000000);
  texture.setTile(0xf5101000, 0x00014050);
  texture.setSize(0xf2000000, 0x0007c07c);
  assert.equal(texture.tiles[7]!.line, 0);
  assert.equal(texture.tiles[0]!.line, 8);
  assert.equal(texture.tiles[0]!.maskS, 5);
  assert.equal(texture.tiles[0]!.maskT, 5);
  assert.equal(texture.tiles[0]!.sh, 124);
  assert.equal(texture.tiles[0]!.th, 124);
  texture.setTile(0xf56a0605, 0x035ef3af);
  assert.deepEqual(texture.tiles[3], {
    format: 3,
    size: 1,
    line: 259,
    tmem: 5,
    palette: 5,
    clampT: true,
    mirrorT: true,
    maskT: 11,
    shiftT: 12,
    clampS: true,
    mirrorS: true,
    maskS: 10,
    shiftS: 15,
    sl: 0,
    tl: 0,
    sh: 0,
    th: 0,
  });
  // Redefining a tile does not overwrite bounds set by SetTileSize.
  texture.setTile(0xf5101000, 0x00014050);
  assert.equal(texture.tiles[0]!.sh, 124);
});

test('RDP LoadBlock copies complete 64-bit words and exchanges the banks of odd texture rows', () => {
  const texture = fixture(),
    source = Uint8Array.from({ length: 64 }, (_, i) => i);
  texture.setImage(0xfd080000, 0);
  texture.setTile(0xf5080000, 0x07000000);
  texture.loadBlock(0xf3000000, 0x0701f400, new DataView(source.buffer)); // 32 bytes, two words per row.
  assert.deepEqual(
    [...texture.bytes.subarray(0, 32)],
    [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 16, 17, 18, 19, 28, 29,
      30, 31, 24, 25, 26, 27,
    ],
  );
  assert.deepEqual(texture.loads, [{ tile: 7, source: 0, bytes: 32, dxt: 1024 }]);
  texture.loadBlock(0xf3000000, 0x07002000, new DataView(source.buffer)); // Three texels still transfer eight bytes.
  assert.deepEqual([...texture.bytes.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(texture.loads[1]!.bytes, 8);
});

test('RDP DXT row carry, tile stride and TMEM wrap apply at 64-bit transfer boundaries', () => {
  const texture = fixture(),
    source = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  texture.setImage(0xfd080000, 0);
  texture.setTile(0xf50803ff, 0x07000000); // Start at word 511, one extra word skipped each row.
  texture.loadBlock(0xf3000000, 0x070372ab, new DataView(source.buffer)); // 56 bytes, ceil(2048/3) DXT.
  assert.deepEqual([...texture.bytes.subarray(4088)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    [...texture.bytes.subarray(0, 16)],
    [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
  );
  assert.ok(texture.bytes.subarray(16, 24).every((value) => value === 0));
  assert.deepEqual([...texture.bytes.subarray(24, 32)], [29, 30, 31, 32, 25, 26, 27, 28]);
  assert.deepEqual([...texture.bytes.subarray(56, 64)], [49, 50, 51, 52, 53, 54, 55, 56]);
});

test('RDP RGBA16 sampling decodes exact colors and reverses the odd-row bank exchange', () => {
  const texture = fixture(),
    source = new DataView(new ArrayBuffer(32));
  [0xf801, 0x07c1, 0x003f, 0xffff, 0x0001, 0xfffe, 0x8431, 0x0000].forEach((value, i) =>
    source.setUint16(i * 2, value, false),
  );
  texture.setImage(0xfd100000, 0);
  texture.setTile(0xf5100000, 0x07000000);
  texture.loadBlock(0xf3000000, 0x07007800, source);
  texture.setTile(0xf5100200, 0x00080200); // Render stride 8 bytes, clamp both axes.
  texture.setSize(0xf2000000, 0x0000c004); // 4 by 2.
  assert.deepEqual(texture.sample(0, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(texture.sample(0, 32, 0), [0, 255, 0, 255]);
  assert.deepEqual(texture.sample(0, 64, 0), [0, 0, 255, 255]);
  assert.deepEqual(texture.sample(0, 96, 0), [255, 255, 255, 255]);
  assert.deepEqual(texture.sample(0, 0, 32), [0, 0, 0, 255]);
  assert.deepEqual(texture.sample(0, 32, 32), [255, 255, 255, 0]);
  assert.deepEqual(texture.sample(0, 64, 32), [132, 132, 198, 255]);
  assert.deepEqual(texture.sample(0, 96, 32), [0, 0, 0, 0]);
  assert.deepEqual(texture.sample(0, -32, -32), [255, 0, 0, 255]);
  assert.deepEqual(texture.sample(0, 9999, 9999), [0, 0, 0, 0]);
});

test('RDP point sampling applies origins, coordinate shifts, wrapping and mirrored periods', () => {
  const texture = fixture(),
    tile = texture.tiles[0]!;
  Object.assign(tile, { format: 4, size: 1, line: 1, maskS: 2, sh: 12 });
  texture.bytes.set([10, 20, 30, 40]);
  assert.equal(texture.sample(0, 4 * 32, 0)[0], 10);
  assert.equal(texture.sample(0, -32, 0)[0], 40);
  tile.mirrorS = true;
  assert.equal(texture.sample(0, 4 * 32, 0)[0], 40);
  assert.equal(texture.sample(0, 5 * 32, 0)[0], 30);
  assert.equal(texture.sample(0, -32, 0)[0], 10);
  tile.clampS = true;
  assert.equal(texture.sample(0, 9999, 0)[0], 40);
  tile.mirrorS = false;
  tile.clampS = false;
  tile.shiftS = 1;
  assert.equal(texture.sample(0, 64, 0)[0], 20);
  tile.shiftS = 15;
  assert.equal(texture.sample(0, 32, 0)[0], 30);
  tile.shiftS = 0;
  tile.sl = 8;
  tile.sh = 20;
  assert.equal(texture.sample(0, 2 * 32, 0)[0], 10);
});

test('RDP intensity and alpha formats expand bits without borrowing neighboring texels', () => {
  const texture = fixture(),
    tile = texture.tiles[0]!;
  texture.bytes.set([0x96, 0xa5]);
  Object.assign(tile, { format: 3, size: 2 });
  assert.deepEqual(texture.sample(0, 0, 0), [150, 150, 150, 165]);
  tile.size = 1;
  assert.deepEqual(texture.sample(0, 0, 0), [153, 153, 153, 102]);
  tile.size = 0;
  tile.sh = 4;
  assert.deepEqual(texture.sample(0, 0, 0), [146, 146, 146, 255]);
  assert.deepEqual(texture.sample(0, 32, 0), [109, 109, 109, 0]);
  tile.format = 4;
  assert.deepEqual(texture.sample(0, 0, 0), [153, 153, 153, 153]);
  assert.deepEqual(texture.sample(0, 32, 0), [102, 102, 102, 102]);
  tile.format = 2;
  assert.throws(() => texture.sample(0, 0, 0), /rdp-texture-format/);
});

test('RDP rejected loads do not mutate TMEM, and restored texture state owns its bytes and descriptors', () => {
  const texture = fixture(),
    ram = new DataView(new ArrayBuffer(16));
  texture.setImage(0xfd100000, 0);
  texture.setTile(0xf5100000, 0x07000000);
  const before = texture.snapshot();
  assert.throws(() => texture.loadBlock(0xf3000000, 0x0701f000, ram), /rdp-texture-range/);
  assert.deepEqual(texture.snapshot(), before);
  assert.throws(() => texture.loadBlock(0xf3001000, 0x07007000, ram), /zero S\/T origin/);
  texture.setImage(0xfd100000, 2);
  assert.throws(() => texture.loadBlock(0xf3000000, 0x07003000, ram), /eight-byte-aligned source/);
  texture.setImage(0xfd100000, 0);
  texture.loadBlock(0xf3000000, 0x07007000, ram);
  const state = texture.snapshot(),
    restored = fixture();
  restored.restore(state);
  state.bytes[0] = 255;
  state.tiles[7]!.sh = 999;
  state.image.address = 999;
  state.loads[0]!.source = 999;
  assert.deepEqual(restored.snapshot(), texture.snapshot());
});

test('RDP three-point filtering chooses the correct diagonal and clamps neighboring taps', () => {
  const texture = fixture(),
    tile = texture.tiles[0]!;
  Object.assign(tile, { format: 0, size: 2, line: 1, sh: 4, th: 4, clampS: true, clampT: true });
  // Red, green / blue, white. Odd-row halves are exchanged in TMEM.
  texture.bytes.set([0xf8, 0x01, 0x07, 0xc1], 0);
  texture.bytes.set([0x00, 0x3f, 0xff, 0xff], 12);
  assert.deepEqual(texture.sampleFiltered(0, 8, 8), [128, 64, 64, 255]);
  assert.deepEqual(texture.sampleFiltered(0, 24, 24), [128, 191, 191, 255]);
  assert.deepEqual(texture.sampleFiltered(0, 32, 32), [255, 255, 255, 255]);
  assert.deepEqual(texture.sampleFiltered(0, -32, -32), [255, 0, 0, 255]);
});

test('packed texture filtering matches the scalar sampler across formats, shifts, masks and seams', () => {
  const texture = fixture(),
    tile = texture.tiles[0]!;
  let seed = 0x544d454d;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < texture.bytes.length; i++) {
    texture.bytes[i] = next() >>> 24;
  }
  const coordinate = (
    value: number,
    shift: number,
    low: number,
    high: number,
    mask: number,
    mirror: boolean,
    clamp: boolean,
  ) => {
    const shifted = shift <= 10 ? Math.floor(value / 2 ** shift) : value * 2 ** (16 - shift);
    let result = Math.floor((shifted - low * 8) / 32);
    if (clamp || mask === 0) {
      result = Math.max(0, Math.min(Math.max(0, (high - low) >> 2), result));
    }
    if (mask) {
      const width = 2 ** mask,
        period = mirror ? width * 2 : width;
      result = ((result % period) + period) % period;
      if (mirror && result >= width) {
        result = period - 1 - result;
      }
    }
    return result;
  };
  // Scalar array-valued taps intentionally retain the previous arithmetic
  // and modulo order, independently of packed colors and integer wrapping.
  const texel = (p: N64Tile, x: number, y: number) => {
    const address =
        ((p.tmem + y * p.line) * 8 + Math.floor((x * (4 * 2 ** p.size)) / 8)) ^ ((y & 1) * 4),
      byte = texture.bytes[address & 4095]!,
      half = byte * 256 + texture.bytes[(address + 1) & 4095]!;
    if (p.format === 0) {
      const expand = (v: number) => (v << 3) | (v >>> 2);
      return [
        expand(half >>> 11),
        expand((half >>> 6) & 31),
        expand((half >>> 1) & 31),
        (half & 1) * 255,
      ];
    }
    if (p.format === 3 && p.size === 2) {
      return [byte, byte, byte, half & 255];
    }
    if (p.format === 3 && p.size === 1) {
      const intensity = (byte >>> 4) * 17;
      return [intensity, intensity, intensity, (byte & 15) * 17];
    }
    const nibble = x & 1 ? byte & 15 : byte >>> 4;
    if (p.format === 3) {
      const v = nibble >>> 1,
        intensity = (v << 5) | (v << 2) | (v >>> 1);
      return [intensity, intensity, intensity, (nibble & 1) * 255];
    }
    const intensity = p.size ? byte : nibble * 17;
    return [intensity, intensity, intensity, intensity];
  };
  const reference = (s: number, t: number, filtered: boolean) => {
    if (!filtered) {
      return texel(
        tile,
        coordinate(s, tile.shiftS, tile.sl, tile.sh, tile.maskS, tile.mirrorS, tile.clampS),
        coordinate(t, tile.shiftT, tile.tl, tile.th, tile.maskT, tile.mirrorT, tile.clampT),
      );
    }
    const shift = (v: number, n: number) => (n <= 10 ? Math.floor(v / 2 ** n) : v * 2 ** (16 - n)),
      ss = shift(s, tile.shiftS) - tile.sl * 8,
      tt = shift(t, tile.shiftT) - tile.tl * 8,
      fx = ((ss % 32) + 32) % 32,
      fy = ((tt % 32) + 32) % 32;
    const tap = (dx: number, dy: number) =>
      texel(
        tile,
        coordinate(
          Math.floor(ss / 32) * 32 + dx * 32,
          0,
          0,
          tile.sh - tile.sl,
          tile.maskS,
          tile.mirrorS,
          tile.clampS,
        ),
        coordinate(
          Math.floor(tt / 32) * 32 + dy * 32,
          0,
          0,
          tile.th - tile.tl,
          tile.maskT,
          tile.mirrorT,
          tile.clampT,
        ),
      );
    const lower = fx + fy < 32,
      a = lower ? tap(0, 0) : tap(1, 1),
      b = tap(1, 0),
      c = tap(0, 1);
    return a.map((base, i) =>
      Math.max(
        0,
        Math.min(
          255,
          Math.floor(
            lower
              ? base + ((b[i]! - base) * fx + (c[i]! - base) * fy + 16) / 32
              : base + ((b[i]! - base) * (32 - fy) + (c[i]! - base) * (32 - fx) + 16) / 32,
          ),
        ),
      ),
    );
  };
  const formats = [
    [0, 2],
    [3, 2],
    [3, 1],
    [3, 0],
    [4, 1],
    [4, 0],
  ];
  for (let i = 0; i < 2000; i++) {
    const [format, size] = formats[i % formats.length]!;
    Object.assign(tile, {
      format,
      size,
      line: next() & 511,
      tmem: next() & 511,
      sl: next() & 4095,
      tl: next() & 4095,
      maskS: (i >>> 1) & 15,
      maskT: (i >>> 5) & 15,
      shiftS: i & 15,
      shiftT: (i >>> 4) & 15,
      clampS: !!(i & 64),
      clampT: !!(i & 128),
      mirrorS: !!(i & 256),
      mirrorT: !!(i & 512),
    });
    tile.sh = tile.sl + (next() & 4095);
    tile.th = tile.tl + (next() & 4095);
    const s = (next() | 0) / (i % 3 ? 1 : 4),
      t = (next() | 0) / (i % 3 ? 1 : 4);
    for (const filtered of [false, true]) {
      assert.deepEqual(
        filtered ? texture.sampleFiltered(0, s, t) : texture.sample(0, s, t),
        reference(s, t, filtered),
        `sample ${i}, filter=${filtered}`,
      );
      const packed = texture.prepare(0, filtered)(s, t);
      assert.deepEqual(
        [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255],
        reference(s, t, filtered),
        `prepared sample ${i}, filter=${filtered}`,
      );
    }
  }
});
