/** RDP triangles already contain screen-space edges and interpolation planes.
 * Transforming vertices and calculating these coefficients belongs to the
 * original RSP microcode. See SGI RDP Command Summary, tables 12–15. */
export interface RdpPlane {
  value: number[];
  dx: number[];
  de: number[];
  dy: number[];
}
export interface RdpTriangle {
  opcode: number;
  tile: number;
  level: number;
  leftMajor: boolean;
  yh: number;
  ym: number;
  yl: number;
  xh: number;
  xm: number;
  xl: number;
  dxh: number;
  dxm: number;
  dxl: number;
  shade?: RdpPlane;
  texture?: RdpPlane;
  depth?: RdpPlane;
}

export function decodeRdpTriangle(words: readonly number[]): RdpTriangle {
  const high = words[0]!,
    low = words[1]!,
    opcode = (high >>> 24) & 63;
  const signedY = (value: number) => ((value << 18) >> 18) / 4;
  const fixed = (index: number) => (words[index]! | 0) / 65536;
  const triangle: RdpTriangle = {
    opcode,
    tile: (high >>> 16) & 7,
    level: (high >>> 19) & 7,
    leftMajor: (high & 0x800000) !== 0,
    yl: signedY(high & 0x3fff),
    ym: signedY((low >>> 16) & 0x3fff),
    yh: signedY(low & 0x3fff),
    xl: fixed(2),
    dxl: fixed(3),
    xh: fixed(4),
    dxh: fixed(5),
    xm: fixed(6),
    dxm: fixed(7),
  };
  let offset = 8;
  const plane = (): RdpPlane => {
    // Each four-lane vector is split across integer and fractional words.
    const read = (integer: number, fraction: number) =>
      Array.from({ length: 4 }, (_, lane) => {
        const shift = lane & 1 ? 0 : 16;
        const hi = (words[offset + integer + (lane >>> 1)]! >>> shift) & 65535;
        const lo = (words[offset + fraction + (lane >>> 1)]! >>> shift) & 65535;
        return ((hi << 16) | lo) / 65536;
      });
    const result = { value: read(0, 4), dx: read(2, 6), de: read(8, 12), dy: read(10, 14) };
    offset += 16;
    return result;
  };
  if (opcode & 4) {
    triangle.shade = plane();
  }
  if (opcode & 2) {
    triangle.texture = plane();
  }
  if (opcode & 1) {
    triangle.depth = {
      value: [fixed(offset)],
      dx: [fixed(offset + 1)],
      de: [fixed(offset + 2)],
      dy: [fixed(offset + 3)],
    };
  }
  return triangle;
}

export interface RdpFragment {
  x: number;
  y: number;
  coverage: number;
  shade: number[];
  texture?: number[];
  depth?: number;
  dz: number;
}

const coverageSamples = [
  [0, 0],
  [0.5, 0],
  [0.25, 0.25],
  [0.75, 0.25],
  [0, 0.5],
  [0.5, 0.5],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;
const centerSample = [[0.5, 0.5]] as const;

function evaluatePlane(plane: RdpPlane, along: number, fromEdge: number, sy: number): number[] {
  const result = new Array<number>(plane.value.length);
  for (let i = 0; i < result.length; i++) {
    result[i] =
      plane.value[i]! + plane.de[i]! * along + plane.dx[i]! * fromEdge + plane.dy[i]! * sy;
  }
  return result;
}

/** Reused scanline storage, owned by one synchronous Display Processor.
 * Each pixel occupies eight doubles: RGBA, STW and depth. Coverage zero marks
 * an uncovered edge pixel. No fragment objects or color arrays escape a row. */
export class RdpSpan {
  left = 0;
  right = 0;
  y = 0;
  textured = false;
  depth = false;
  dz = 0;
  readonly values: Float64Array;
  readonly coverage: Uint8Array;
  readonly base = new Float64Array(8);
  readonly first = new Float64Array(8);
  readonly end = new Float64Array(8);
  constructor(readonly width = 1024) {
    this.values = new Float64Array(width * 8);
    this.coverage = new Uint8Array(width);
  }
}

/** Allocation-free scanline path. Plane bases are evaluated once per row.
 * Keep base + dx * fromEdge + dy * centroid in the reference's order: repeated
 * addition of dx can drift at coverage edges and change a quantized pixel. */
export function rasterizeRdpSpans(
  t: RdpTriangle,
  scissor: { left: number; top: number; right: number; bottom: number },
  width: number,
  antialias: boolean,
  span: RdpSpan,
  draw: (span: RdpSpan) => void,
): number {
  if (width > span.width) {
    throw new Error('RDP scanline storage is narrower than the color image.');
  }
  const originY = Math.floor(t.yh),
    samples = antialias ? coverageSamples : centerSample,
    first = span.first,
    end = span.end,
    values = span.values,
    base = span.base;
  span.textured = !!t.texture;
  span.depth = !!t.depth;
  span.dz = t.depth ? Math.abs(t.depth.dx[0]!) + Math.abs(t.depth.dy[0]!) : 0;
  let fragments = 0;
  for (
    let y = Math.max(scissor.top, Math.floor(t.yh));
    y < Math.min(scissor.bottom, Math.ceil(t.yl));
    y++
  ) {
    let rowLeft = Infinity,
      rowRight = -Infinity,
      fullLeft = -Infinity,
      fullRight = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const sx = samples[i]![0],
        sy = samples[i]![1],
        py = y + sy,
        major = t.xh + t.dxh * (py - originY),
        minor = py < t.ym ? t.xm + t.dxm * (py - originY) : t.xl + t.dxl * (py - t.ym),
        left = Math.min(major, minor),
        right = Math.max(major, minor),
        valid = py >= t.yh && py < t.yl;
      rowLeft = Math.min(rowLeft, left);
      rowRight = Math.max(rowRight, right);
      first[i] = valid ? Math.ceil(left - sx) : Infinity;
      end[i] = valid ? Math.ceil(right - sx) : -Infinity;
      fullLeft = Math.max(fullLeft, first[i]!);
      fullRight = Math.min(fullRight, end[i]!);
    }
    span.left = Math.max(0, scissor.left, Math.floor(rowLeft));
    span.right = Math.min(width, scissor.right, Math.ceil(rowRight));
    span.y = y;
    const along = y - originY,
      major = t.xh + t.dxh * along;
    for (let c = 0; c < 4; c++) {
      base[c] = t.shade ? t.shade.value[c]! + t.shade.de[c]! * along : 0;
    }
    for (let c = 0; c < 3; c++) {
      base[4 + c] = t.texture ? t.texture.value[c]! + t.texture.de[c]! * along : 0;
    }
    base[7] = t.depth ? t.depth.value[0]! + t.depth.de[0]! * along : 0;
    for (let x = span.left; x < span.right; x++) {
      const full = x >= fullLeft && x < fullRight;
      let covered = full ? samples.length : 0,
        sumX = 0,
        sumY = 0;
      if (!full) {
        for (let i = 0; i < samples.length; i++) {
          if (x >= first[i]! && x < end[i]!) {
            covered++;
            sumX += samples[i]![0];
            sumY += samples[i]![1];
          }
        }
      }
      span.coverage[x] = covered ? (antialias ? covered : 8) : 0;
      if (!covered) {
        continue;
      }
      const sx = antialias && covered < 8 ? sumX / covered : 0.5,
        sy = antialias && covered < 8 ? sumY / covered : 0.5,
        fromEdge = x + sx - major,
        offset = x * 8;
      for (let c = 0; c < 4; c++) {
        values[offset + c] = t.shade
          ? base[c]! + t.shade.dx[c]! * fromEdge + t.shade.dy[c]! * sy
          : 0;
      }
      if (t.texture) {
        for (let c = 0; c < 3; c++) {
          values[offset + 4 + c] =
            base[4 + c]! + t.texture.dx[c]! * fromEdge + t.texture.dy[c]! * sy;
        }
      }
      if (t.depth) {
        values[offset + 7] = base[7]! + t.depth.dx[0]! * fromEdge + t.depth.dy[0]! * sy;
      }
      fragments++;
    }
    draw(span);
  }
  return fragments;
}

/** Functional eight-sample coverage and coefficient stepping. This models
 * the geometry of subpixel edges; RDP pipeline truncation and centroid rules
 * are not yet a bit-exact hardware implementation. */
export function rasterizeRdpTriangle(
  triangle: RdpTriangle,
  scissor: { left: number; top: number; right: number; bottom: number },
  width: number,
  antialias: boolean,
  pixel: (fragment: RdpFragment) => void,
): number {
  const t = triangle,
    originY = Math.floor(t.yh),
    samples = antialias ? coverageSamples : centerSample,
    first = new Float64Array(samples.length),
    end = new Float64Array(samples.length),
    dz = t.depth ? Math.abs(t.depth.dx[0]!) + Math.abs(t.depth.dy[0]!) : 0;
  let fragments = 0;
  for (
    let y = Math.max(scissor.top, Math.floor(t.yh));
    y < Math.min(scissor.bottom, Math.ceil(t.yl));
    y++
  ) {
    let rowLeft = Infinity,
      rowRight = -Infinity,
      fullLeft = -Infinity,
      fullRight = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const [sx, sy] = samples[i]!,
        py = y + sy,
        major = t.xh + t.dxh * (py - originY),
        minor = py < t.ym ? t.xm + t.dxm * (py - originY) : t.xl + t.dxl * (py - t.ym),
        left = Math.min(major, minor),
        right = Math.max(major, minor),
        valid = py >= t.yh && py < t.yl;
      rowLeft = Math.min(rowLeft, left);
      rowRight = Math.max(rowRight, right);
      first[i] = valid ? Math.ceil(left - sx) : Infinity;
      end[i] = valid ? Math.ceil(right - sx) : -Infinity;
      fullLeft = Math.max(fullLeft, first[i]!);
      fullRight = Math.min(fullRight, end[i]!);
    }
    const left = Math.max(0, scissor.left, Math.floor(rowLeft)),
      right = Math.min(width, scissor.right, Math.ceil(rowRight)),
      along = y - originY,
      major = t.xh + t.dxh * along;
    for (let x = left; x < right; x++) {
      // Interior pixels share all sample intervals. Boundary pixels still
      // count each of the original eight samples and retain its centroid.
      const full = x >= fullLeft && x < fullRight;
      let covered = full ? samples.length : 0,
        sumX = 0,
        sumY = 0;
      if (!full) {
        for (let i = 0; i < samples.length; i++) {
          if (x >= first[i]! && x < end[i]!) {
            covered++;
            sumX += samples[i]![0];
            sumY += samples[i]![1];
          }
        }
      }
      if (!covered) {
        continue;
      }
      const sx = antialias && covered < 8 ? sumX / covered : 0.5,
        sy = antialias && covered < 8 ? sumY / covered : 0.5;
      const fromEdge = x + sx - major;
      const fragment: RdpFragment = {
        x,
        y,
        coverage: antialias ? covered : 8,
        shade: t.shade ? evaluatePlane(t.shade, along, fromEdge, sy) : [0, 0, 0, 0],
        dz,
      };
      if (t.texture) {
        fragment.texture = evaluatePlane(t.texture, along, fromEdge, sy);
      }
      if (t.depth) {
        fragment.depth = evaluatePlane(t.depth, along, fromEdge, sy)[0]!;
      }
      pixel(fragment);
      fragments++;
    }
  }
  return fragments;
}
