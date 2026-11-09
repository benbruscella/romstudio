import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fast3dTasks, fnv1a, type RdpSink } from './fast3d.js';
import { RdpStreamSink, replayRdpFrame, type RdpFrame } from './rdp-stream.js';
import type { N64Display } from './display.js';
import type { RdpPlane, RdpTriangle } from './rdp-triangle.js';

/** Synthetic display lists in a small RDRAM; no cartridge bytes. */
class Builder {
  readonly ram = new Uint8Array(0x10000);
  readonly view = new DataView(this.ram.buffer);
  private list = 0x1000;
  command(w0: number, w1: number): this {
    this.view.setUint32(this.list, w0 >>> 0, false);
    this.view.setUint32(this.list + 4, w1 >>> 0, false);
    this.list += 8;
    return this;
  }
  /** Loads a fixed-point matrix (row vectors) at address and issues G_MTX. */
  matrix(address: number, values: readonly number[], parameters: number): this {
    values.forEach((value, i) => {
      const fixed = Math.round(value * 65536);
      this.view.setInt16(address + i * 2, fixed >> 16, false);
      this.view.setUint16(address + 32 + i * 2, fixed & 0xffff, false);
    });
    return this.command(0x01000040 | (parameters << 16), address);
  }
  viewport(address: number): this {
    [640, 480, 511, 0, 640, 480, 511, 0].forEach((value, i) =>
      this.view.setInt16(address + i * 2, value, false),
    );
    return this.command(0x03800010, address);
  }
  vertices(address: number, list: readonly (readonly number[])[]): this {
    list.forEach(([x, y, z, r, g, b], i) => {
      const o = address + i * 16;
      this.view.setInt16(o, x!, false);
      this.view.setInt16(o + 2, y!, false);
      this.view.setInt16(o + 4, z!, false);
      this.ram.set([r!, g!, b!, 255], o + 12);
    });
    return this.command(0x04000000 | ((list.length - 1) << 20) | (list.length * 16), address);
  }
  triangle(a: number, b: number, c: number): this {
    return this.command(0xbf000000, ((a * 10) << 16) | ((b * 10) << 8) | (c * 10));
  }
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

class RecordingSink implements RdpSink {
  readonly commands: number[][] = [];
  readonly triangles: RdpTriangle[] = [];
  readonly loads: number[][] = [];
  finished = 0;
  command(high: number, low: number, secondHigh: number, secondLow: number): void {
    this.commands.push([high, low, secondHigh, secondLow]);
  }
  triangle(triangle: RdpTriangle): void {
    this.triangles.push(triangle);
  }
  load(address: number, bytes: number): void {
    this.loads.push([address, bytes]);
  }
  finish(): void {
    this.finished++;
  }
}

function evaluate(plane: RdpPlane, t: RdpTriangle, lane: number, x: number, y: number): number {
  return (
    plane.value[lane]! + plane.dx[lane]! * (x - t.xh) + plane.dy[lane]! * (y - Math.floor(t.yh))
  );
}

function scene(): Builder {
  return new Builder()
    .matrix(0x2000, identity, 1 | 2)
    .matrix(0x2040, identity, 2)
    .viewport(0x2080)
    .command(0xb7000000, 0x4 | 0x200); // G_SHADE | G_SHADING_SMOOTH
}

test('Fast3D projects vertices and builds RDP planes that reproduce vertex colors', () => {
  const b = scene()
    .vertices(0x3000, [
      [0, 0, 0, 255, 0, 0],
      [1, 0, 0, 0, 255, 0],
      [0, 1, 0, 0, 0, 255],
    ])
    .triangle(0, 1, 2)
    .command(0xb8000000, 0);
  const sink = new RecordingSink();
  assert.equal(new Fast3dTasks(b.ram, sink).runList(0x1000), true);
  assert.equal(sink.triangles.length, 1);
  assert.equal(sink.finished, 1);
  const t = sink.triangles[0]!;
  assert.equal(t.opcode, 0x0c); // Shaded, untextured, no depth.
  assert.equal(t.yh, 0);
  assert.equal(t.yl, 120);
  // Viewport: x = 160 + 160·x, y = 120 − 120·y (Fast3D flips Y).
  const corners = [
    [160, 120, [255, 0, 0]],
    [320, 120, [0, 255, 0]],
    [160, 0, [0, 0, 255]],
  ] as const;
  for (const [x, y, color] of corners) {
    for (let lane = 0; lane < 3; lane++) {
      assert.ok(Math.abs(evaluate(t.shade!, t, lane, x, y) - color[lane]!) < 1e-6);
    }
  }
});

test('Fast3D culls back faces and clips triangles that cross the near plane', () => {
  const winding = (order: [number, number, number]) => {
    const b = scene()
      .command(0xb7000000, 0x2000) // G_CULL_BACK
      .vertices(0x3000, [
        [0, 0, 0, 255, 255, 255],
        [1, 0, 0, 255, 255, 255],
        [0, 1, 0, 255, 255, 255],
      ])
      .triangle(...order)
      .command(0xb8000000, 0);
    const sink = new RecordingSink();
    new Fast3dTasks(b.ram, sink).runList(0x1000);
    return sink.triangles.length;
  };
  assert.deepEqual([winding([0, 1, 2]), winding([0, 2, 1])].sort(), [0, 1]);

  // Projection with w = z: z + w >= 0 keeps z >= 0, so one vertex behind the
  // eye turns the triangle into a clipped quadrilateral (two triangles).
  const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  const b = new Builder()
    .matrix(0x2000, perspective, 1 | 2)
    .matrix(0x2040, identity, 2)
    .viewport(0x2080)
    .vertices(0x3000, [
      [-1, -1, 2, 0, 0, 0],
      [1, -1, 2, 0, 0, 0],
      [0, 1, -2, 0, 0, 0],
    ])
    .triangle(0, 1, 2)
    .command(0xb8000000, 0);
  const sink = new RecordingSink();
  new Fast3dTasks(b.ram, sink).runList(0x1000);
  assert.equal(sink.triangles.length, 2);
});

test('an unimplemented Fast3D command falls back before any output', () => {
  const b = scene()
    .vertices(0x3000, [
      [0, 0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
    ])
    .triangle(0, 1, 2)
    .command(0xb5000000, 0) // G_LINE3D is not implemented.
    .command(0xb8000000, 0);
  const sink = new RecordingSink();
  const tasks = new Fast3dTasks(b.ram, sink);
  assert.equal(tasks.runList(0x1000), false);
  assert.deepEqual([sink.triangles.length, sink.commands.length, sink.finished], [0, 0, 0]);
  assert.equal(tasks.stats.fallbacks, 1);
  assert.match(tasks.stats.lastFallback, /\$b5/);
});

test('Fast3D records the RDRAM bytes a LoadBlock reads from segmented texture images', () => {
  const b = scene()
    .command(0xbc000006 | ((5 * 4) << 8), 0x8000) // Segment 5 → $8000.
    .command(0xfd100000 | 31, 0x05000100) // 16-bit image, width 32, segment 5 + $100.
    .command(0xf3000000, 0x0707f000 | (0x800 >> 1)) // LoadBlock texels 0..127.
    .command(0xb8000000, 0);
  const sink = new RecordingSink();
  assert.equal(new Fast3dTasks(b.ram, sink).runList(0x1000), true);
  assert.deepEqual(sink.loads, [[0x8100, 256]]);
  assert.equal(sink.commands[0]![1], 0x8100); // The image address is translated.
});

test('the RDP stream replays the same commands, triangles and texture snapshots', () => {
  const ram = new Uint8Array(64);
  ram.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
  const local: number[][] = [];
  const remote: { commands: number[][]; triangles: RdpTriangle[] } = {
    commands: [],
    triangles: [],
  };
  const display = (log: number[][], triangles?: RdpTriangle[]) =>
    ({
      submit: (...words: number[]) => log.push(words),
      submitTriangle: (t: RdpTriangle) => triangles?.push(t),
    }) as unknown as N64Display;
  let frame: RdpFrame | undefined;
  const sink = new RdpStreamSink(ram, display(local), (f) => (frame = f));
  const triangle: RdpTriangle = {
    opcode: 0x0f,
    tile: 2,
    level: 0,
    leftMajor: true,
    yh: 1.25,
    ym: 4,
    yl: 9.5,
    xh: 3,
    xm: 3.5,
    xl: 7,
    dxh: 0.5,
    dxm: -1,
    dxl: 2,
    shade: { value: [1, 2, 3, 4], dx: [5, 6, 7, 8], de: [9, 10, 11, 12], dy: [13, 14, 15, 16] },
    texture: { value: [1, 2, 3, 0], dx: [4, 5, 6, 0], de: [7, 8, 9, 0], dy: [1, 1, 1, 0] },
    depth: { value: [100], dx: [1], de: [2], dy: [3] },
  };
  sink.load(16, 8);
  sink.command(0xf3000000, 0x0700f000, 0, 0);
  sink.triangle(triangle);
  sink.command(0xe9000000, 0, 0, 0); // FullSync
  sink.finish();
  assert.ok(frame?.fullSync);
  assert.deepEqual(local, [[0xe9000000, 0, 0, 0]]); // The machine sees FullSync now.
  ram.fill(0); // Later CPU writes must not change the snapshot.
  const mirror = new Uint8Array(64);
  replayRdpFrame(frame, display(remote.commands, remote.triangles), mirror);
  assert.deepEqual([...mirror.subarray(16, 24)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(remote.commands, [
    [0xf3000000, 0x0700f000, 0, 0],
    [0xe9000000, 0, 0, 0],
  ]);
  assert.deepEqual(remote.triangles, [triangle]);
});

test('microcode identity uses FNV-1a over the exact bytes', () => {
  assert.equal(fnv1a(new Uint8Array(0), 0, 0), 0x811c9dc5);
  assert.equal(fnv1a(Uint8Array.from([0x61]), 0, 1), 0xe40c292c);
});
