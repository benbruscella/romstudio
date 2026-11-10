import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreparedRdpCombiner } from './rdp-combiner.js';
import { N64PixelPipeline, type RdpColor } from './rdp-pixels.js';
import { N64Texture } from './texture.js';
import { RdpSpan, type RdpFragment } from './rdp-triangle.js';

const fail = (kind: string, detail: string): never => {
  throw new Error(`${kind}: ${detail}`);
};
const attempt = <T>(fn: () => T): T | string => {
  try {
    return fn();
  } catch (error) {
    return (error as Error).message;
  }
};

test('prepared mux plans match scalar colors and first errors, including both feedback cycles and unused inputs', () => {
  const words = new Uint32Array(128),
    texture = new N64Texture(fail),
    reference = new N64PixelPipeline(new DataView(new ArrayBuffer(128)), texture, words, fail);
  let seed = 0x4d555845;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  let colors = 0,
    errors = 0;
  for (let k = 0; k < 12000; k++) {
    words[120] = next();
    words[121] = next();
    if (k % 4 === 0) {
      words[120] = 0xfcffffff;
      words[121] = 0xfffcf87c;
    }
    if (k % 4 === 1) {
      words[120] = 0xfc30b261;
      words[121] = 0x44664924;
    }
    if (k % 4 === 2) {
      words[120] = 0xfc127e24;
      words[121] = 0xfffff9fc;
    }
    words[116] = next();
    words[117] = next();
    words[119] = next();
    const texel = Array.from({ length: 4 }, () => (next() % 8192) / 8 - 256) as RdpColor,
      shade = Array.from({ length: 4 }, () => (next() % 8192) / 8 - 256) as RdpColor;
    for (const cycle of [0, 1]) {
      const prepared = new PreparedRdpCombiner(words, cycle, fail);
      prepared.sources.set(texel, 4);
      prepared.sources.set(shade, 12);
      const expected = attempt(() => reference.combine(texel, shade, cycle));
      assert.deepEqual(
        attempt(() => [...prepared.evaluate()]),
        expected,
        `mux ${k}, cycle ${cycle}`,
      );
      if (prepared.directRgb && typeof expected !== 'string') {
        assert.equal(
          prepared.evaluateDirectAlpha(texel[3], shade[3]),
          expected[3],
          `direct alpha ${k}`,
        );
      }
      if (typeof expected === 'string') {
        errors++;
      } else {
        colors++;
      }
    }
  }
  assert.ok(colors > 5000);
  assert.ok(errors > 1000);
});

test('prepared scanline writes preserve scalar framebuffer, hidden bits, depth, blending and failure boundaries', () => {
  const words = new Uint32Array(128),
    texture = new N64Texture(fail),
    ram = new Uint8Array(4096),
    actual = new Uint8Array(4096),
    scalar = new N64PixelPipeline(new DataView(ram.buffer), texture, words, fail),
    fast = new N64PixelPipeline(new DataView(actual.buffer), texture, words, fail),
    span = new RdpSpan(16);
  let seed = 0x5350414e;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < texture.bytes.length; i++) {
    texture.bytes[i] = next() >>> 24;
  }
  const modes = [
    [0xfcffffff, 0xfffe793c],
    [0xfcffffff, 0xfffcf87c],
    [0xfc30b261, 0x44664924],
    [0xfc127e24, 0xfffff9fc],
  ];
  for (let k = 0; k < 3000; k++) {
    for (let i = 0; i < ram.length; i++) {
      ram[i] = next() >>> 24;
    }
    actual.set(ram);
    for (let i = 0; i < scalar.hidden.length; i++) {
      scalar.hidden[i] = next() & 3;
    }
    fast.hidden.set(scalar.hidden);
    scalar.written = fast.written = scalar.rejectedDepth = fast.rejectedDepth = 0;
    for (let i = 0; i < words.length; i++) {
      words[i] = next();
    }
    const mux = modes[k % modes.length]!;
    words[120] = mux[0]!;
    words[121] = mux[1]!;
    if (k % 17 === 0) {
      words[120] = next();
      words[121] = next();
    }
    words[125] = k % 19 === 0 ? 4096 : k % 13 === 0 ? 256 : 2048;
    const state = {
      modeHigh: next() & 0x3fffff,
      modeLow: next(),
      colorImage: {
        format: k % 23 === 0 ? 2 : 0,
        size: k % 29 === 0 ? 1 : 2 + (k & 1),
        width: 16,
        address: k % 31 === 0 ? 257 : 256,
      },
    };
    const tile = texture.tiles[0]!;
    Object.assign(tile, {
      format: k % 37 === 0 ? 2 : 3,
      size: k % 3,
      line: 2,
      tmem: next() & 511,
      sh: 60,
      th: 60,
      maskS: k & 7,
      maskT: (k >>> 3) & 7,
      shiftS: k & 15,
      shiftT: (k >>> 4) & 15,
    });
    span.y = k & 3;
    span.left = 2;
    span.right = 7;
    span.textured = !!(k & 2);
    span.depth = !!(k & 4);
    span.dz = (next() & 1023) / 16;
    const fragments: RdpFragment[] = [];
    for (let x = span.left; x < span.right; x++) {
      const shade = Array.from({ length: 4 }, () => (next() & 4095) / 8 - 128),
        stw = [(next() & 65535) - 32768, (next() & 65535) - 32768, (next() & 65535) - 32768],
        depth = (next() & 0x7ffff) / 8,
        coverage = 1 + ((next() >>> 24) & 7),
        fragment: RdpFragment = { x, y: span.y, coverage, shade, dz: span.dz };
      if (span.textured) {
        fragment.texture = stw;
      }
      if (span.depth) {
        fragment.depth = depth;
      }
      fragments.push(fragment);
      span.coverage[x] = coverage;
      span.values.set([...shade, ...stw, depth], x * 8);
    }
    const copy = k % 5 === 0;
    const expected = attempt(() => {
      for (const f of fragments) {
        scalar.write(state, f, 0, copy);
      }
    });
    const got = attempt(() => fast.prepare(state, 0, copy).write(span));
    assert.equal(got, expected, `error ${k}`);
    assert.deepEqual(actual, ram, `RDRAM ${k}`);
    assert.deepEqual(fast.hidden, scalar.hidden, `hidden ${k}`);
    assert.equal(fast.written, scalar.written, `written ${k}`);
    assert.equal(fast.rejectedDepth, scalar.rejectedDepth, `depth rejected ${k}`);
  }
});

test('opaque scanlines preserve texture/shade colors, coverage edges and ordered framebuffer failures', () => {
  const words = new Uint32Array(128),
    texture = new N64Texture(fail),
    ram = new Uint8Array(1024),
    actual = new Uint8Array(1024),
    scalar = new N64PixelPipeline(new DataView(ram.buffer), texture, words, fail),
    fast = new N64PixelPipeline(new DataView(actual.buffer), texture, words, fail),
    span = new RdpSpan(16);
  let seed = 0x4f504151;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 4096; i++) {
    texture.bytes[i] = next() >>> 24;
  }
  const flags = [0, 8, 0x200, 0x208, 4, 0x2000, 0x2008, 0x10, 0x4000, 0x1000, 1, 0x100, 0x300];
  for (let k = 0; k < 1600; k++) {
    for (let i = 0; i < ram.length; i++) {
      ram[i] = next() >>> 24;
    }
    actual.set(ram);
    for (let i = 0; i < scalar.hidden.length; i++) {
      scalar.hidden[i] = next() & 3;
    }
    fast.hidden.set(scalar.hidden);
    scalar.written = fast.written = scalar.rejectedDepth = fast.rejectedDepth = 0;
    words[120] = 0xfcffffff;
    words[121] = k & 1 ? 0xfffcf87c : 0xfffe793c;
    words[115] = next();
    const state = {
      modeHigh: (k & 4 ? 0x80000 : 0) | (k & 8 ? 0x2c00 : 0),
      modeLow: flags[k % flags.length]!,
      colorImage: {
        format: 0,
        size: 2,
        width: 16,
        address: k % 23 === 0 ? 1020 : k % 29 === 0 ? 129 : 128,
      },
    };
    Object.assign(texture.tiles[0]!, {
      format: k % 6 < 2 ? 0 : k % 6 < 4 ? 3 : 4,
      size: k % 6 < 2 ? 2 : k % 3 < 2 ? 1 : 0,
      line: 2,
      tmem: k & 511,
      sh: 60,
      th: 60,
      maskS: 4,
      maskT: 4,
      mirrorS: !!(k & 16),
      mirrorT: !!(k & 32),
    });
    span.y = k & 3;
    span.left = 0;
    span.right = 16;
    span.textured = !!(k & 1);
    span.depth = false;
    span.dz = 0;
    const fragments: RdpFragment[] = [];
    for (let x = 0; x < 16; x++) {
      const coverage = x === 0 ? 0 : x === 1 ? 3 : x === 15 ? 7 : 8,
        shade = Array.from({ length: 4 }, () => ((next() >>> 16) - 16384) / 32),
        st = [(next() & 4095) - 2048, (next() & 4095) - 2048, (next() & 65535) - 1024];
      span.coverage[x] = coverage;
      span.values.set([...shade, ...st, 0], x * 8);
      if (coverage) {
        const f: RdpFragment = { x, y: span.y, coverage, shade, dz: 0 };
        if (span.textured) {
          f.texture = st;
        }
        fragments.push(f);
      }
    }
    const copy = k % 7 === 0;
    const expected = attempt(() => {
      for (const f of fragments) {
        scalar.write(state, f, 0, copy);
      }
    });
    assert.equal(
      attempt(() => fast.prepare(state, 0, copy).write(span)),
      expected,
      `error ${k}`,
    );
    assert.deepEqual(actual, ram, `RGBA ${k}`);
    assert.deepEqual(fast.hidden, scalar.hidden, `hidden ${k}`);
    assert.equal(fast.written, scalar.written);
    assert.equal(fast.rejectedDepth, scalar.rejectedDepth);
  }
});
