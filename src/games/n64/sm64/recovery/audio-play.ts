import { AspMainTasks } from '../../../../systems/n64/aspmain.js';
import { N64System } from '../../../../systems/n64/system.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';

/**
 * Build-time differential check for the play tier's audio microcode
 * implementation (systems/n64/aspmain.ts). Each case runs one whole audio
 * task twice from identical RDRAM, DMEM and vector flags: once on the
 * cartridge's original RSP words (decoded by the recovery interpreter after
 * the boot loader's copies) and once through AspMainTasks. Every RDRAM and
 * DMEM byte and the final VCO must match, or the implementation must decline
 * the task and leave both memories untouched.
 */

/** Where the cartridge stores the EU audio microcode (canonical byte order). */
export const sm64AudioMicrocode = { text: 0xb7f10, data: 0xc7390, dataBytes: 0x2c0 } as const;

const TEXT = 0x100000,
  DATA = 0x101000,
  LIST = 0x102000,
  /** Scratch RDRAM for codebooks, samples and states. */
  HEAP = 0x110000;

export interface AudioTaskCase {
  name: string;
  commands: (readonly [number, number])[];
  /** Initial RDRAM writes (address, bytes). */
  ram: (readonly [number, Uint8Array])[];
  /** Stale DMEM before the boot loader (OSTask fields are filled in). */
  dmem: Uint8Array;
  carry: number;
  vector: Uint16Array;
}

export interface AudioTaskComparison {
  name: string;
  handled: boolean;
  passed: boolean;
  instructions: number;
  detail: string;
}

/** First differing byte, or -1. A native comparison decides equality. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (Buffer.from(a.buffer, a.byteOffset, a.length).equals(b)) {
    return -1;
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return n;
}

/** Runs one case on the original microcode and through the implementation. */
export function compareAudioTask(
  text: Uint8Array,
  data: Uint8Array,
  recovery: RspRecovery,
  item: AudioTaskCase,
): AudioTaskComparison {
  const ram = new Uint8Array(4194304);
  ram.set(text.subarray(0, 0x1000), TEXT);
  ram.set(data, DATA);
  const list = new DataView(ram.buffer);
  item.commands.forEach(([w0, w1], i) => {
    list.setUint32(LIST + i * 8, w0 >>> 0, false);
    list.setUint32(LIST + i * 8 + 4, w1 >>> 0, false);
  });
  for (const [address, bytes] of item.ram) {
    ram.set(bytes, address);
  }
  const dmem = item.dmem.slice(0, 4096),
    task = new DataView(dmem.buffer);
  [2, 0, 0x80000000 + 0x2f7240, 0xd0, TEXT, 0x800, DATA, data.length, 0, 0, 0, 0]
    .concat([LIST, item.commands.length * 8, 0, 0])
    .forEach((word, i) => task.setUint32(0xfc0 + i * 4, word >>> 0, false));

  // Original: the boot loader's copies, then IMEM $080 with $at = $FC0.
  const system = new N64System(new Uint8Array(0), 0),
    signal = system.memory.signal;
  system.memory.ram.bytes.set(ram);
  signal.memory.set(dmem);
  signal.memory.set(data, 0);
  signal.memory.set(text.subarray(0, 0xf80), 0x1080);
  system.rsp.vector.registers.set(item.vector);
  system.rsp.vector.carry = item.carry;
  system.rsp.set(1, 0xfc0);
  system.enableRsp(recovery.step);
  signal.pc = 0x080;

  // Implementation: from the same pre-boot memories.
  const hleRam = ram.slice(),
    hleSignal = new Uint8Array(8192);
  hleSignal.set(dmem);
  const vector = { carry: item.carry },
    tasks = new AspMainTasks(hleRam, vector),
    handled = tasks.run(new DataView(hleSignal.buffer));

  let finished = false,
    fault = '';
  try {
    signal.write(0x10, 1);
    const budget = 40000000;
    while ((signal.status & 1) === 0 && system.ticks < budget) {
      system.advanceClock();
    }
    finished = (signal.status & 0x201) === 0x201;
  } catch (error) {
    // Outside the implementation's envelope the original can corrupt its
    // own IMEM or issue a DMA beyond RDRAM; the implementation must decline.
    fault = error instanceof Error ? error.message : String(error);
  }
  const instructions = system.rsp.instructions;
  if (!finished) {
    return {
      name: item.name,
      handled,
      passed: !handled,
      instructions,
      detail: `original did not finish (${fault || 'budget'}); implementation ${handled ? 'ran' : 'declined'}`,
    };
  }
  if (!handled) {
    const unchanged =
      firstDifference(hleRam, ram) < 0 && firstDifference(hleSignal.subarray(0, 4096), dmem) < 0;
    return {
      name: item.name,
      handled,
      passed: unchanged,
      instructions,
      detail: unchanged ? `declined: ${tasks.stats.lastFallback}` : 'declined but changed memory',
    };
  }
  const ramAt = firstDifference(hleRam, system.memory.ram.bytes),
    dmemAt = firstDifference(hleSignal.subarray(0, 4096), signal.memory.subarray(0, 4096)),
    carryMatches = vector.carry === system.rsp.vector.carry;
  const passed = ramAt < 0 && dmemAt < 0 && carryMatches;
  return {
    name: item.name,
    handled,
    passed,
    instructions,
    detail: passed
      ? 'identical'
      : [
          ramAt >= 0
            ? `RDRAM $${ramAt.toString(16)}: ${system.memory.ram.bytes[ramAt]} vs ${hleRam[ramAt]}`
            : '',
          dmemAt >= 0
            ? `DMEM $${dmemAt.toString(16)}: ${signal.memory[dmemAt]} vs ${hleSignal[dmemAt]}`
            : '',
          carryMatches ? '' : `VCO ${system.rsp.vector.carry} vs ${vector.carry}`,
        ]
          .filter(Boolean)
          .join('; '),
  };
}

/** Small deterministic generator (mulberry32). */
export class AudioCaseRandom {
  constructor(private state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(limit: number): number {
    return Math.floor(this.next() * limit);
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)]!;
  }
  /** Signed sample: full range, extremes and small values. */
  sample(): number {
    const kind = this.next();
    if (kind < 0.55) {
      return this.int(65536) - 32768;
    }
    if (kind < 0.8) {
      return this.pick([32767, -32768, -32767, 0, 1, -1, 16384, -16384]);
    }
    return this.int(512) - 256;
  }
  bytes(count: number): Uint8Array {
    return Uint8Array.from({ length: count }, () => this.int(256));
  }
  samples(count: number): Uint8Array {
    const bytes = new Uint8Array(count * 2),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
      view.setInt16(i * 2, this.sample(), false);
    }
    return bytes;
  }
}

const kinds = [
  'adpcm',
  'resample',
  'envmixer',
  'mixer',
  'interleave',
  'clear',
  'move',
  'buffers',
  'sequence',
] as const;

/** Random cases over every implemented command, including counts that are
 * not multiples of the loop size, A_INIT/A_LOOP/A_AUX flags, extreme
 * samples, gains and ramps, inherited VCO and stale DMEM/vector state. A
 * few buffers fall outside the implementation's envelope on purpose. */
export function randomAudioCases(seed: number, count: number): AudioTaskCase[] {
  const random = new AudioCaseRandom(seed),
    cases: AudioTaskCase[] = [];
  for (let n = 0; n < count; n++) {
    const kind = kinds[n % kinds.length]!;
    cases.push(randomCase(random, kind === 'sequence' ? 'sequence' : kind, `${kind}-${seed}-${n}`));
  }
  return cases;
}

function randomCase(random: AudioCaseRandom, kind: string, name: string): AudioTaskCase {
  const commands: (readonly [number, number])[] = [],
    ram: (readonly [number, Uint8Array])[] = [];
  let heap = HEAP;
  const allocate = (bytes: Uint8Array) => {
    const address = heap;
    ram.push([address, bytes]);
    heap += (bytes.length + 15) & ~15;
    return address;
  };
  // DMEM buffer offsets relative to $5C0, mostly 16-byte aligned.
  const offset = (bytes: number) => {
    const roll = random.next();
    if (roll < 0.03) {
      return random.int(0x1000) & ~1; // possibly outside the envelope
    }
    const limit = Math.max(16, 0x9d0 - bytes);
    return roll < 0.06 ? random.int(limit) & ~1 : random.int(limit) & ~15;
  };
  const vector = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    vector[i] = random.int(65536);
  }
  const dmem = random.bytes(4096);
  const carry = random.next() < 0.3 ? random.int(65536) : 0;
  const segment = random.next() < 0.25;
  if (segment) {
    commands.push([0x07000000, 0x05000000 | 0x10000]);
  }
  const pointer = (address: number) => (segment ? 0x05000000 | (address - 0x10000) : address);

  const add = (which: string) => {
    switch (which) {
      case 'adpcm': {
        const entries = 1 + random.int(8),
          book = new Uint8Array(entries * 32),
          view = new DataView(book.buffer);
        for (let i = 0; i < entries * 16; i++) {
          view.setInt16(i * 2, random.next() < 0.7 ? random.int(8192) - 4096 : random.sample());
        }
        commands.push([0x0b000000 | book.length, pointer(allocate(book))]);
        const total = random.pick([0, 32, 64, 96, 160, 320, 0x170, 0x180, random.int(0x300)]);
        const frames = Math.ceil(total / 32);
        const input = offset(frames * 9 + 16),
          output = offset(32 + frames * 32);
        const encoded = random.bytes(frames * 9 + 16);
        for (let f = 0; f < frames; f++) {
          encoded[f * 9] = (random.int(16) << 4) | random.int(entries);
        }
        const loaded = allocate(encoded);
        commands.push([0x08000000 | (input & 0xffff), (0 << 16) | ((encoded.length + 7) & ~7)]);
        commands.push([0x04000000, pointer(loaded)]);
        commands.push([0x08000000 | (input & 0xffff), ((output & 0xffff) << 16) | total]);
        const state = allocate(random.samples(16)),
          loop = allocate(random.samples(16));
        const flags = random.int(4);
        if (flags & 2) {
          commands.push([0x0f000000, pointer(loop)]);
        }
        commands.push([0x01000000 | (flags << 16), pointer(state)]);
        break;
      }
      case 'resample': {
        const total = random.pick([0, 16, 32, 0x60, 0x170, 0x180, random.int(0x300) & ~1]);
        const pitch = random.pick([
          0x8000,
          0x4000,
          0xffff,
          0,
          1,
          random.int(65536),
          random.int(0x10000),
        ]);
        const input = offset(0x400) + 32,
          output = offset(total + 16);
        const state = new Uint8Array(32),
          view = new DataView(state.buffer);
        state.set(random.samples(4), 0);
        view.setUint16(8, random.int(65536));
        view.setUint16(10, random.pick([0, 2, 4, 6, 8, 14, random.int(16)]));
        state.set(random.samples(8), 16);
        state.set(random.bytes(4), 12);
        commands.push([0x08000000 | (input & 0xffff), ((output & 0xffff) << 16) | total]);
        commands.push([0x05000000 | (random.int(4) << 16) | pitch, pointer(allocate(state))]);
        break;
      }
      case 'envmixer': {
        const total = random.pick([16, 32, 0x60, 0x170, 0x180, random.int(0x200)]);
        const input = offset(total + 32),
          dryLeft = offset(total + 32),
          dryRight = offset(total + 32),
          wetLeft = offset(total + 32),
          wetRight = offset(total + 32);
        const aux = random.next() < 0.5 ? 8 : 0;
        commands.push([0x08000000 | (input & 0xffff), ((dryLeft & 0xffff) << 16) | total]);
        commands.push([0x08080000 | (dryRight & 0xffff), ((wetLeft & 0xffff) << 16) | wetRight]);
        const volume = () =>
          random.next() < 0.5 ? random.int(32768) : random.pick([0, 32767, -32768, -1, 0x7fff]);
        const rate = () => {
          const roll = random.next();
          if (roll < 0.4) {
            return 0x10000 + random.int(0x800) - 0x400; // near 1.0
          }
          if (roll < 0.7) {
            return random.int(0x20000);
          }
          return random.int(4294967296) | 0;
        };
        commands.push([0x09060000 | (volume() & 0xffff), 0]); // left volume
        commands.push([0x09040000 | (volume() & 0xffff), 0]); // right volume
        commands.push([0x09020000 | (volume() & 0xffff), rate()]); // left target/rate
        commands.push([0x09000000 | (volume() & 0xffff), rate()]); // right target/rate
        commands.push([0x09080000 | (random.sample() & 0xffff), random.sample() & 0xffff]); // dry/wet
        const init = random.next() < 0.5 ? 1 : 0;
        const state = new Uint8Array(80),
          view = new DataView(state.buffer);
        for (let i = 0; i < 40; i++) {
          view.setInt16(i * 2, random.next() < 0.5 ? random.int(32768) : random.sample());
        }
        // Plausible saved parameters: targets, rates near 1.0, gains.
        if (random.next() < 0.6) {
          for (const side of [0, 3]) {
            const r = rate();
            view.setUint16(64 + side * 2, random.int(32768));
            view.setUint16(64 + side * 2 + 2, r >>> 16);
            view.setUint16(64 + side * 2 + 4, r & 0xffff);
          }
        }
        commands.push([0x03000000 | ((init | aux) << 16), pointer(allocate(state))]);
        break;
      }
      case 'mixer': {
        const total = random.pick([0, 32, 64, 0x170, 0x180, random.int(0x300)]);
        const input = offset(total + 32),
          output = offset(total + 32);
        commands.push([0x08000000, total]);
        commands.push([
          0x0c000000 | (random.sample() & 0xffff),
          ((input & 0xffff) << 16) | (output & 0xffff),
        ]);
        break;
      }
      case 'interleave': {
        const total = random.pick([0, 16, 0x170, 0x180, random.int(0x200)]);
        const left = offset(total + 16),
          right = offset(total + 16),
          output = offset(total * 2 + 32);
        commands.push([0x08000000, ((output & 0xffff) << 16) | total]);
        commands.push([0x0d000000, ((left & 0xffff) << 16) | (right & 0xffff)]);
        break;
      }
      case 'clear': {
        const total = random.pick([0, 1, 16, 17, 0x170, random.int(0x400)]);
        commands.push([0x02000000 | (offset(total + 16) & 0xffff), total]);
        break;
      }
      case 'move': {
        const total = random.pick([0, 1, 16, 17, 0x170, random.int(0x400)]);
        commands.push([
          0x0a000000 | (offset(total + 16) & 0xffff),
          ((offset(total + 16) & 0xffff) << 16) | total,
        ]);
        break;
      }
      case 'buffers': {
        const total = random.pick([8, 16, 0x170, random.int(0x400) + 1]);
        const source = allocate(random.bytes(total + 16)),
          target = allocate(new Uint8Array(total + 16));
        const a = offset(total + 16) & ~7,
          b = offset(total + 16) & ~7;
        commands.push([0x08000000 | (a & 0xffff), ((b & 0xffff) << 16) | total]);
        commands.push([0x04000000, pointer(source)]);
        commands.push([0x06000000, pointer(target)]);
        commands.push([0x00000000, 0]);
        break;
      }
    }
  };
  if (kind === 'sequence') {
    const steps = 2 + random.int(10);
    for (let i = 0; i < steps; i++) {
      add(random.pick(kinds.slice(0, -1)));
    }
  } else {
    add(kind);
  }
  return { name, commands, ram, dmem, carry, vector };
}
