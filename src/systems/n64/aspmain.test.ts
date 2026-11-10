import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AspMainTasks, aspMainMicrocode } from './aspmain.js';

/**
 * Synthetic command lists, no cartridge bytes. The data image here holds
 * only the jump table (the microcode's IMEM handler offsets) and a made-up
 * RESAMPLE filter table whose 64 phases all select the newest tap with gain
 * $7FFF. Expected values are computed by hand from the documented vector
 * arithmetic; the real microcode is compared separately by the SM64
 * recovery check (games/n64/sm64/recovery/audio-play.ts).
 */
const handlers = [
  0x1118, 0x1470, 0x11dc, 0x1b38, 0x1214, 0x187c, 0x1254, 0x12d0, 0x12ec, 0x1328, 0x140c, 0x1294,
  0x1e24, 0x138c, 0x170c, 0x144c,
];
function dataImage(): Uint8Array {
  const image = new Uint8Array(0x2c0),
    view = new DataView(image.buffer);
  handlers.forEach((handler, i) => view.setUint16(0x10 + i * 2, handler, false));
  for (let phase = 0; phase < 64; phase++) {
    view.setInt16(0xc0 + phase * 8 + 6, 0x7fff, false);
  }
  return image;
}

const LIST = 0x1000,
  BUFFER = 0x5c0;

class Task {
  readonly ram = new Uint8Array(0x10000);
  readonly view = new DataView(this.ram.buffer);
  readonly dmem = new Uint8Array(4096);
  readonly dmemView = new DataView(this.dmem.buffer);
  readonly vector = { carry: 0 };
  readonly tasks = new AspMainTasks(this.ram, this.vector);
  private readonly commands: number[][] = [];
  command(w0: number, w1: number): this {
    this.commands.push([w0 >>> 0, w1 >>> 0]);
    return this;
  }
  /** SETBUFF: DMEM offsets are relative to $5C0. */
  buffers(input: number, output: number, count: number): this {
    return this.command(0x08000000 | input, (output << 16) | count);
  }
  samples(address: number, values: readonly number[]): this {
    values.forEach((value, i) => this.dmemView.setInt16(address + i * 2, value, false));
    return this;
  }
  read(address: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => this.dmemView.getInt16(address + i * 2, false));
  }
  readRam(address: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => this.view.getInt16(address + i * 2, false));
  }
  run(): boolean {
    this.commands.forEach(([w0, w1], i) => {
      this.view.setUint32(LIST + i * 8, w0!, false);
      this.view.setUint32(LIST + i * 8 + 4, w1!, false);
    });
    return this.tasks.runTask(this.dmem, dataImage(), LIST, this.commands.length * 8);
  }
}

test('CLEARBUFF clears whole 16-byte groups and DMEMMOVE copies them', () => {
  const task = new Task();
  task.dmem.fill(0xaa, BUFFER, BUFFER + 0x80);
  task.command(0x02000000 | 0x10, 17); // 17 bytes -> two groups
  task.command(0x0a000000 | 0x40, (0x60 << 16) | 1); // one group
  task.dmem.fill(0x11, BUFFER + 0x40, BUFFER + 0x50);
  assert.equal(task.run(), true);
  assert.deepEqual([...task.dmem.subarray(BUFFER, BUFFER + 0x10)], new Array(16).fill(0xaa));
  assert.deepEqual([...task.dmem.subarray(BUFFER + 0x10, BUFFER + 0x30)], new Array(32).fill(0));
  assert.equal(task.dmem[BUFFER + 0x30], 0xaa);
  assert.deepEqual([...task.dmem.subarray(BUFFER + 0x60, BUFFER + 0x70)], new Array(16).fill(0x11));
  assert.equal(task.dmem[BUFFER + 0x70], 0xaa);
});

test('LOADBUFF and SAVEBUFF round counts up to eight bytes and use segments', () => {
  const task = new Task();
  task.ram.set([1, 2, 3, 4, 5, 6, 7, 8, 9], 0x4000);
  task.command(0x07000000, 0x03000000 | 0x3000); // segment 3 = $3000
  task.buffers(0x20, 0x20, 5);
  task.command(0x04000000, 0x03000000 | 0x1000); // load 8 bytes from $4000
  task.command(0x06000000, 0x5000); // save them to $5000
  assert.equal(task.run(), true);
  assert.deepEqual(
    [...task.dmem.subarray(BUFFER + 0x20, BUFFER + 0x29)],
    [1, 2, 3, 4, 5, 6, 7, 8, 0],
  );
  assert.deepEqual([...task.ram.subarray(0x5000, 0x5009)], [1, 2, 3, 4, 5, 6, 7, 8, 0]);
  // Buffer state at $360: input, output, count.
  assert.deepEqual(
    [0, 2, 4].map((o) => task.dmemView.getUint16(0x360 + o, false)),
    [BUFFER + 0x20, BUFFER + 0x20, 5],
  );
});

test('MIXER keeps the destination at $7FFF and adds the rounded scaled input', () => {
  const task = new Task();
  const output = BUFFER,
    input = BUFFER + 0x40;
  task.samples(output, [1000, 30000, -30000, 0, -1, 1, 32767, -32768]);
  task.samples(input, [2000, 30000, -30000, 0, 0, 0, 32767, -32768]);
  task.command(0x08000000, 16); // 16 bytes still mixes a whole 32-byte group
  task.command(0x0c000000 | 0x4000, (0x40 << 16) | 0x00);
  assert.equal(task.run(), true);
  // floor((out * 0xFFFE + 0x8000 + in * gain * 2) / 65536), saturated.
  assert.deepEqual(task.read(output, 8), [2000, 32767, -32768, 0, -1, 1, 32767, -32768]);
});

test('INTERLEAVE alternates eight left and eight right samples per group', () => {
  const task = new Task();
  task.samples(BUFFER + 0x100, [1, 2, 3, 4, 5, 6, 7, 8]);
  task.samples(BUFFER + 0x200, [-1, -2, -3, -4, -5, -6, -7, -8]);
  task.command(0x08000000, (0x300 << 16) | 16);
  task.command(0x0d000000, (0x100 << 16) | 0x200);
  assert.equal(task.run(), true);
  assert.deepEqual(
    task.read(BUFFER + 0x300, 16),
    [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8],
  );
});

test('ADPCM decodes residuals through the codebook predictor and saves its state', () => {
  const task = new Task();
  // Codebook entry 0: zero; entry 1: book1[0] = 2048 (1.0 times sample 14).
  const book = new Uint8Array(64),
    bookView = new DataView(book.buffer);
  bookView.setInt16(32, 2048, false);
  task.ram.set(book, 0x2000);
  // Frame 0: scale 11 (shift 1), entry 0; residuals 7, -8, 1, 0, ...
  // Frame 1: scale 12 (no shift), entry 1; residuals 1, 0, ...
  const frames = new Uint8Array(32);
  frames.set([0xb0, 0x78, 0x10], 0);
  frames.set([0xc1, 0x10], 9);
  task.ram.set(frames, 0x2100);
  task.command(0x0b000000 | 64, 0x2000); // LOADADPCM
  task.buffers(0x00, 0x00, 32);
  task.command(0x04000000, 0x2100); // frames to $5C0
  task.buffers(0x00, 0x40, 64); // in $5C0, out $600, two frames
  task.command(0x01010000, 0x3000); // A_INIT, state at $3000
  assert.equal(task.run(), true);
  const output = BUFFER + 0x40;
  // Initial state (zero) comes first.
  assert.deepEqual(task.read(output, 16), new Array(16).fill(0));
  // Frame 0: (nibble << 12) >> 1 with a zero codebook.
  assert.deepEqual(task.read(output + 32, 4), [0x3800, -0x4000, 0x0800, 0]);
  // Frame 1: x << 12 plus 1.0 x previous sample 14 (zero) in lane 0; the
  // second half adds 1.0 x this frame's sample 6 in its lane 0.
  assert.deepEqual(task.read(output + 64, 2), [0x1000, 0]);
  assert.equal(task.read(output + 64 + 16, 1)[0], 0);
  // State: the last 16 samples written.
  assert.deepEqual(task.readRam(0x3000, 16), task.read(output + 64, 16));
});

test('RESAMPLE steps through history and input at the pitch, saving position and taps', () => {
  const task = new Task();
  const input = BUFFER + 0x100,
    output = BUFFER + 0x300;
  task.samples(input, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
  task.command(0x08000000 | 0x100, (0x300 << 16) | 16);
  // Pitch $8000 is one input sample per output; A_INIT zeroes history.
  task.command(0x05018000, 0x3000);
  assert.equal(task.run(), true);
  // The filter selects tap 3 at gain $7FFF: output k is element k + 3 of
  // [h0, h1, h2, h3, input...], i.e. the last history sample, then input.
  assert.deepEqual(task.read(output, 8), [0, 10, 20, 30, 40, 50, 60, 70]);
  // State: four samples at the next position, its fraction, alignment.
  assert.deepEqual(task.readRam(0x3000, 4), [50, 60, 70, 80]);
  assert.equal(task.view.getUint16(0x3008, false), 0);
});

test('ENVMIXER ramps volume by its rate each eight samples and stops at the target', () => {
  const task = new Task();
  const input = BUFFER,
    dryLeft = BUFFER + 0x100,
    dryRight = BUFFER + 0x200;
  task.samples(input, new Array(16).fill(1000));
  task.command(0x08000000 | 0x00, (0x100 << 16) | 32);
  task.command(0x08080000 | 0x200, (0x300 << 16) | 0x400); // dry right, wet L/R
  task.command(0x09060000 | 0x1000, 0); // left volume
  task.command(0x09040000 | 0x4000, 0); // right volume
  task.command(0x09020000 | 0x3000, 0x00020000); // left target, rate 2.0
  task.command(0x09000000 | 0x4000, 0x00010000); // right target, rate 1.0
  task.command(0x09080000 | 0x7fff, 0); // dry $7FFF, wet 0
  task.command(0x03010000, 0x3000); // A_INIT
  assert.equal(task.run(), true);
  // Left volumes: first block interpolates $1000 -> $2000 by eighths
  // ($2000 * k fractions; lane 7 uses $FFFF), the next block doubles and
  // stops at $3000. Gain = VMULF(volume, $7FFF); output = round(x * gain).
  const leftVolumes = [
    0x1200, 0x1400, 0x1600, 0x1800, 0x1a00, 0x1c00, 0x1e00, 0x1fff, 0x2400, 0x2800, 0x2c00, 0x3000,
    0x3000, 0x3000, 0x3000, 0x3000,
  ];
  const expected = leftVolumes.map((volume) => {
    const gain = Math.floor((volume * 0x7fff * 2 + 0x8000) / 65536);
    return Math.floor((0x8000 + 1000 * gain * 2) / 65536);
  });
  assert.deepEqual(task.read(dryLeft, 16), expected);
  // Right: constant $4000 -> gain $4000 -> 500.
  assert.deepEqual(task.read(dryRight, 16), new Array(16).fill(500));
  // State: the last block's clamped left volumes, then the parameters.
  assert.deepEqual(task.readRam(0x3000, 8), leftVolumes.slice(8));
  assert.equal(task.view.getUint16(0x3000 + 64, false), 0x3000);
});

test('an unsupported command abandons the task and undoes RDRAM and DMEM', () => {
  const task = new Task();
  task.ram.fill(0x55, 0x5000, 0x5010);
  task.dmem.fill(0x33, BUFFER, BUFFER + 16);
  const before = task.dmem.slice();
  task.buffers(0, 0, 16);
  task.command(0x02000000, 16); // CLEARBUFF
  task.command(0x06000000, 0x5000); // SAVEBUFF zeros
  task.command(0x0e000000, 0); // POLEF: left to the original microcode
  assert.equal(task.run(), false);
  assert.deepEqual([...task.ram.subarray(0x5000, 0x5010)], new Array(16).fill(0x55));
  assert.deepEqual(task.dmem, before);
  assert.equal(task.tasks.stats.fallbacks, 1);
  assert.match(task.tasks.stats.lastFallback, /\$e/);
});

test('buffers outside the DMEM buffer area and unaligned vector buffers decline', () => {
  const wrapped = new Task();
  wrapped.command(0x02000000 | 0xf000, 16); // $F000 + $5C0 wraps within DMEM to $5C0
  assert.equal(wrapped.run(), true);
  const scratch = new Task();
  scratch.command(0x02000000 | 0x9d0, 32); // reaches $F90 scratch
  assert.equal(scratch.run(), false);
  const unaligned = new Task();
  unaligned.command(0x08000000, 32).command(0x0c000000, (0x48 << 16) | 0x02);
  assert.equal(unaligned.run(), false);
});

test('only fresh audio tasks for the exact microcode images are recognized', () => {
  const ram = new Uint8Array(0x10000),
    tasks = new AspMainTasks(ram),
    dmem = new DataView(new ArrayBuffer(4096));
  dmem.setUint32(0xfc0, 2, false);
  dmem.setUint32(0xfd0, 0x1000, false);
  dmem.setUint32(0xfd8, 0x2000, false);
  dmem.setUint32(0xfdc, aspMainMicrocode.dataBytes, false);
  assert.equal(tasks.recognizes(dmem), false); // hashes do not match zeros
  assert.equal(tasks.run(dmem), false);
  dmem.setUint32(0xfc0, 1, false);
  assert.equal(tasks.recognizes(dmem), false);
});
