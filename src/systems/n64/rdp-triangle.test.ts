import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRdpTriangle,
  rasterizeRdpTriangle,
  rasterizeRdpSpans,
  RdpSpan,
  type RdpTriangle,
  type RdpFragment,
} from './rdp-triangle.js';

const triangle = (overrides: Partial<RdpTriangle> = {}): RdpTriangle => ({
  opcode: 8,
  tile: 0,
  level: 0,
  leftMajor: true,
  yh: 1,
  ym: 1,
  yl: 5,
  xh: 1,
  dxh: 0,
  xm: 1,
  dxm: 0,
  xl: 5,
  dxl: -1,
  ...overrides,
});
const clip = { left: 0, top: 0, right: 8, bottom: 8 };
function fragments(t: RdpTriangle, aa = false, scissor = clip) {
  const found: RdpFragment[] = [];
  rasterizeRdpTriangle(t, scissor, 8, aa, (p) => found.push(p));
  return found;
}

test('RDP packet decoding sign-extends edges and reassembles split shade/texture fractions', () => {
  const words = [
    0xcf850014, 0x000c3ffc, 0x00050000, 0xffff0000, 0xffff8000, 0x00010000, 0x00028000, 0,
    0x0001fffe, 0x000300ff, 0x000afffb, 0, 0x8000c000, 0xc0008000, 0x40008000, 0, 0x00020003, 0,
    0x00040005, 0, 0x80004000, 0, 0x20001000, 0, 0x00200040, 0x40000000, 0x00010002, 0, 0x80004000,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x000a8000, 0xffff8000, 0x00020000, 0x00010000,
  ];
  const t = decodeRdpTriangle(words);
  assert.deepEqual(
    [t.tile, t.level, t.yh, t.ym, t.yl, t.xh, t.xl, t.dxh, t.dxl],
    [5, 0, -1, 3, 5, -0.5, 5, 1, -1],
  );
  assert.deepEqual(t.shade!.value, [1.5, -1.25, 3.75, 255.5]);
  assert.deepEqual(t.shade!.dx, [10.25, -4.5, 0, 0]);
  assert.deepEqual(t.shade!.de, [2.5, 3.25, 0, 0]);
  assert.deepEqual(t.shade!.dy, [4.125, 5.0625, 0, 0]);
  assert.deepEqual(t.texture!.value, [32.5, 64.25, 16384, 0]);
  assert.deepEqual(t.depth, { value: [10.5], dx: [-0.5], de: [2], dy: [1] });
});

test('RDP edge walking partitions a rectangle without holes or shared-edge double writes', () => {
  const first = fragments(triangle()),
    second = fragments(triangle({ ym: 5, xh: 5, xm: 5, dxm: -1, xl: 1, leftMajor: false }));
  assert.equal(first.length, 6);
  assert.equal(second.length, 10);
  const points = new Set([...first, ...second].map((p) => `${p.x},${p.y}`));
  assert.equal(points.size, 16);
  for (let y = 1; y < 5; y++) {
    for (let x = 1; x < 5; x++) {
      assert.ok(points.has(`${x},${y}`));
    }
  }
  const clipped = fragments(triangle(), false, { left: 2, top: 2, right: 4, bottom: 4 });
  assert.deepEqual(
    clipped.map((p) => [p.x, p.y]),
    [[2, 2]],
  );
});

test('RDP subpixel coverage retains a thin triangle missed by a pixel-center sample', () => {
  const t = triangle({ yh: 0, ym: 0, yl: 0.25, xh: 0, xm: 0, xl: 0.25, dxl: -1 });
  assert.equal(fragments(t).length, 0);
  const aa = fragments(t, true);
  assert.equal(aa.length, 1);
  assert.deepEqual([aa[0]!.x, aa[0]!.y, aa[0]!.coverage], [0, 0, 1]);
});

test('RDP attributes use distinct per-edge, per-X and subpixel per-Y coefficients', () => {
  const t = triangle({
    yh: 0,
    ym: 0,
    yl: 6,
    xh: 0,
    dxh: 1,
    xl: 7,
    dxl: 0,
    shade: { value: [100.5, 0, 0, 255], dx: [10, 0, 0, 0], de: [20, 0, 0, 0], dy: [5, 0, 0, 0] },
  });
  const p = fragments(t).find((p) => p.x === 2 && p.y === 2)!;
  assert.equal(p.shade[0], 148);
});

test('scanline intervals match independent per-pixel coverage and attribute evaluation', () => {
  let seed = 0x524450;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const fixed = () => ((next() & 0xfffff) - 0x80000) / 65536;
  for (let iteration = 0; iteration < 400; iteration++) {
    const yh = ((next() % 32) - 16) / 4,
      ym = yh + (next() % 24) / 4,
      yl = ym + (next() % 40) / 4;
    const plane = (length: number) => ({
      value: Array.from({ length }, fixed),
      dx: Array.from({ length }, fixed),
      de: Array.from({ length }, fixed),
      dy: Array.from({ length }, fixed),
    });
    const t = triangle({
      yh,
      ym,
      yl,
      xh: fixed(),
      xm: fixed(),
      xl: fixed(),
      dxh: fixed(),
      dxm: fixed(),
      dxl: fixed(),
      shade: plane(4),
      texture: plane(4),
      depth: plane(1),
    });
    const scissor = { left: next() % 5, top: next() % 4, right: 20, bottom: 16 };
    for (const aa of [false, true]) {
      const actual: RdpFragment[] = [],
        expected: RdpFragment[] = [];
      const count = rasterizeRdpTriangle(t, scissor, 24, aa, (f) => actual.push(f));
      // Intentionally evaluate every sample at every pixel: this reference
      // neither derives integer intervals nor shares the interior shortcut.
      const samples = aa
        ? [
            [0, 0],
            [0.5, 0],
            [0.25, 0.25],
            [0.75, 0.25],
            [0, 0.5],
            [0.5, 0.5],
            [0.25, 0.75],
            [0.75, 0.75],
          ]
        : [[0.5, 0.5]];
      for (
        let y = Math.max(scissor.top, Math.floor(yh));
        y < Math.min(scissor.bottom, Math.ceil(yl));
        y++
      ) {
        for (let x = scissor.left; x < scissor.right; x++) {
          let covered = 0,
            sumX = 0,
            sumY = 0;
          for (const [sx, sy] of samples) {
            const py = y + sy!,
              major = t.xh + t.dxh * (py - Math.floor(yh)),
              minor = py < ym ? t.xm + t.dxm * (py - Math.floor(yh)) : t.xl + t.dxl * (py - ym);
            if (
              py >= yh &&
              py < yl &&
              x + sx! >= Math.min(major, minor) &&
              x + sx! < Math.max(major, minor)
            ) {
              covered++;
              sumX += sx!;
              sumY += sy!;
            }
          }
          if (!covered) {
            continue;
          }
          const sx = aa && covered < 8 ? sumX / covered : 0.5,
            sy = aa && covered < 8 ? sumY / covered : 0.5,
            along = y - Math.floor(yh),
            fromEdge = x + sx - (t.xh + t.dxh * along);
          const evaluate = (p: NonNullable<RdpTriangle['shade']>) =>
            p.value.map((base, i) => base + p.de[i]! * along + p.dx[i]! * fromEdge + p.dy[i]! * sy);
          expected.push({
            x,
            y,
            coverage: aa ? covered : 8,
            shade: evaluate(t.shade!),
            texture: evaluate(t.texture!),
            depth: evaluate(t.depth!)[0]!,
            dz: Math.abs(t.depth!.dx[0]!) + Math.abs(t.depth!.dy[0]!),
          });
        }
      }
      assert.equal(count, expected.length);
      assert.deepEqual(actual, expected, `triangle ${iteration}, AA=${aa}`);
      const spans: RdpFragment[] = [];
      const spanCount = rasterizeRdpSpans(t, scissor, 24, aa, new RdpSpan(24), (row) => {
        for (let x = row.left; x < row.right; x++) {
          if (!row.coverage[x]) {
            continue;
          }
          const i = x * 8;
          spans.push({
            x,
            y: row.y,
            coverage: row.coverage[x]!,
            shade: [...row.values.subarray(i, i + 4)],
            texture: [...row.values.subarray(i + 4, i + 7)],
            depth: row.values[i + 7]!,
            dz: row.dz,
          });
        }
      });
      assert.equal(spanCount, expected.length);
      assert.deepEqual(
        spans,
        expected.map((f) => ({ ...f, texture: f.texture!.slice(0, 3) })),
        `span triangle ${iteration}, AA=${aa}`,
      );
    }
  }
});
