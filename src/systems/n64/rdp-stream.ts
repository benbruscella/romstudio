import type { N64Display } from './display.js';
import type { RdpSink } from './fast3d.js';
import type { RdpPlane, RdpTriangle } from './rdp-triangle.js';

/**
 * Play tier: one graphics task's RDP work, serialized for a parallel RDP
 * worker. The guest never reads RDP output back, only the DP interrupt, so
 * the machine raises FullSync immediately while drawing happens elsewhere.
 * Texture loads carry a snapshot of the RDRAM bytes they read, taken at the
 * moment the task ran, so later CPU writes cannot change what is drawn.
 */
export interface RdpFrame {
  numbers: Float64Array;
  bytes: Uint8Array;
  fullSync: boolean;
}

const command = 1,
  triangleRecord = 2,
  load = 3;

export class RdpStreamSink implements RdpSink {
  private numbers = new Float64Array(1 << 16);
  private count = 0;
  private bytes = new Uint8Array(1 << 16);
  private byteCount = 0;
  private fullSync = false;

  constructor(
    private readonly ram: Uint8Array,
    private readonly display: N64Display,
    private readonly send: (frame: RdpFrame) => void,
  ) {}

  private reserve(numbers: number): void {
    if (this.count + numbers > this.numbers.length) {
      const grown = new Float64Array(Math.max(this.numbers.length * 2, this.count + numbers));
      grown.set(this.numbers.subarray(0, this.count));
      this.numbers = grown;
    }
  }

  command(high: number, low: number, secondHigh: number, secondLow: number): void {
    this.reserve(5);
    const n = this.numbers;
    n[this.count++] = command;
    n[this.count++] = high;
    n[this.count++] = low;
    n[this.count++] = secondHigh;
    n[this.count++] = secondLow;
    if (((high >>> 24) & 63) === 0x29) {
      // FullSync: the machine's own display counts it and raises DP now.
      this.fullSync = true;
      this.display.submit(high, low, 0, 0);
    }
  }

  triangle(t: RdpTriangle): void {
    this.reserve(14 + 3 * 17);
    const n = this.numbers;
    n[this.count++] = triangleRecord;
    n[this.count++] = t.opcode;
    n[this.count++] = t.tile;
    n[this.count++] = t.level;
    n[this.count++] = t.leftMajor ? 1 : 0;
    n[this.count++] = t.yh;
    n[this.count++] = t.ym;
    n[this.count++] = t.yl;
    n[this.count++] = t.xh;
    n[this.count++] = t.xm;
    n[this.count++] = t.xl;
    n[this.count++] = t.dxh;
    n[this.count++] = t.dxm;
    n[this.count++] = t.dxl;
    for (const plane of [t.shade, t.texture, t.depth]) {
      if (!plane) {
        continue;
      }
      const lanes = plane.value.length;
      n[this.count++] = lanes;
      for (const values of [plane.value, plane.dx, plane.de, plane.dy]) {
        for (let lane = 0; lane < lanes; lane++) {
          n[this.count++] = values[lane]!;
        }
      }
    }
  }

  load(address: number, bytes: number): void {
    if (this.byteCount + bytes > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.byteCount + bytes));
      grown.set(this.bytes.subarray(0, this.byteCount));
      this.bytes = grown;
    }
    this.bytes.set(this.ram.subarray(address, address + bytes), this.byteCount);
    this.reserve(4);
    const n = this.numbers;
    n[this.count++] = load;
    n[this.count++] = address;
    n[this.count++] = bytes;
    n[this.count++] = this.byteCount;
    this.byteCount += bytes;
  }

  finish(): void {
    if (this.count === 0) {
      return;
    }
    const frame: RdpFrame = {
      numbers: this.numbers.slice(0, this.count),
      bytes: this.bytes.slice(0, this.byteCount),
      fullSync: this.fullSync,
    };
    this.count = 0;
    this.byteCount = 0;
    this.fullSync = false;
    this.send(frame);
  }
}

/** Replays a serialized task on an RDP whose RDRAM is a private mirror. */
export function replayRdpFrame(frame: RdpFrame, display: N64Display, ram: Uint8Array): void {
  const n = frame.numbers;
  let i = 0;
  const plane = (): RdpPlane => {
    const lanes = n[i++]!,
      read = () => Array.from({ length: lanes }, () => n[i++]!);
    return { value: read(), dx: read(), de: read(), dy: read() };
  };
  while (i < n.length) {
    const kind = n[i++];
    if (kind === command) {
      display.submit(n[i]!, n[i + 1]!, n[i + 2]!, n[i + 3]!);
      i += 4;
    } else if (kind === load) {
      const address = n[i]!,
        bytes = n[i + 1]!,
        offset = n[i + 2]!;
      ram.set(frame.bytes.subarray(offset, offset + bytes), address);
      i += 3;
    } else if (kind === triangleRecord) {
      const opcode = n[i++]!;
      const t: RdpTriangle = {
        opcode,
        tile: n[i++]!,
        level: n[i++]!,
        leftMajor: n[i++] === 1,
        yh: n[i++]!,
        ym: n[i++]!,
        yl: n[i++]!,
        xh: n[i++]!,
        xm: n[i++]!,
        xl: n[i++]!,
        dxh: n[i++]!,
        dxm: n[i++]!,
        dxl: n[i++]!,
      };
      if (opcode & 4) {
        t.shade = plane();
      }
      if (opcode & 2) {
        t.texture = plane();
      }
      if (opcode & 1) {
        t.depth = plane();
      }
      display.submitTriangle(t);
    } else {
      throw new Error('The RDP stream is malformed.');
    }
  }
}
