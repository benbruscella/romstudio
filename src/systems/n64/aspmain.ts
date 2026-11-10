import { fnv1a } from './fast3d.js';

/**
 * Play tier: a high-level implementation of the audio microcode ("aspMain",
 * audio ABI 1) as shipped in SM64 EU.
 *
 * The reference tier runs the cartridge's original RSP instructions. This
 * file is ROM Studio's own TypeScript account of that exact microcode, used
 * only by Play and only for the text/data images identified below. Each
 * command restates the original vector arithmetic per lane: the same
 * products, accumulator slices, roundings, saturations, loop counts, DMA
 * sizes and DMEM side effects, so the RDRAM it writes matches the original
 * instructions byte for byte. It encodes no game rules.
 *
 * DMEM is modelled as a private 4 KiB mirror that follows the microcode's own
 * layout (command chunk at $380, segments at $320, buffer state at $360,
 * codebook at $4C0, buffers from $5C0, scratch from $F90). Anything outside
 * the checked envelope (unknown commands, unaligned vector buffers, buffers
 * that would overlap the data image or scratch, multi-row or IMEM DMA)
 * abandons the task: RDRAM writes are undone and the mirror is discarded, so
 * the original microcode then runs from the untouched machine state.
 *
 * References: the recovered RSP words in the package (game-code/rsp*),
 * checked by differential tests against the original microcode; command
 * fields as named in n64decomp/sm64 include/PR/abi.h.
 */

/** SM64 EU audio microcode, identified by FNV-1a hashes of its code span
 * (IMEM $080-$E9F; the boot loader also copies unused bytes after it) and of
 * its 704-byte data image. */
export const aspMainMicrocode = {
  name: 'aspMain (audio ABI 1, SM64 EU)',
  codeBytes: 0xe20,
  code: 0xb649785b,
  dataBytes: 0x2c0,
  data: 0x6e78d7c8,
} as const;

class AudioUnsupported extends Error {}

const STATE = 0x360, // in, out, count, volumes, ramps, loop address
  SEGMENTS = 0x320,
  COMMANDS = 0x380,
  CHUNK = 320,
  CODEBOOK = 0x4c0,
  BUFFERS = 0x5c0,
  SCRATCH = 0xf90, // RESAMPLE/ENVMIXER state, address lists, wet scratch
  DATA = 0x2c0; // end of the data image: constants, masks, filter table

/** Jump targets in the data image's command table (IMEM offsets). */
const enum Handler {
  Noop = 0x118,
  Adpcm = 0x470,
  ClearBuffer = 0x1dc,
  EnvelopeMixer = 0xb38,
  LoadBuffer = 0x214,
  Resample = 0x87c,
  SaveBuffer = 0x254,
  Segment = 0x2d0,
  SetBuffer = 0x2ec,
  SetVolume = 0x328,
  MoveBuffer = 0x40c,
  LoadCodebook = 0x294,
  Mixer = 0xe24,
  Interleave = 0x38c,
  Filter = 0x70c,
  SetLoop = 0x44c,
}

/** ENVMIXER's per-lane ramp fractions (data image $0B0): k/8, lane 7 $FFFF. */
const rampFractions = [0x2000, 0x4000, 0x6000, 0x8000, 0xa000, 0xc000, 0xe000, 0xffff];

function clamp16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}
/** Low accumulator slice as VMADN/VMUDN return it (saturated by the high
 * part), as an unsigned halfword. */
function fraction(accumulator: number): number {
  const high = Math.floor(accumulator / 65536);
  return high < -32768 ? 0 : high > 32767 ? 0xffff : accumulator & 0xffff;
}
/** VMULF: signed fractional product with the rounding half-unit. */
function fractional(a: number, b: number): number {
  return clamp16(Math.floor((a * b * 2 + 0x8000) / 65536));
}
/** VMULF by $7FFF then VMACF: keep the destination and add a scaled input. */
function mix(destination: number, input: number, gain: number): number {
  return clamp16(Math.floor((destination * 0xfffe + 0x8000 + input * gain * 2) / 65536));
}
function signed16(value: number): number {
  return (value << 16) >> 16;
}

export class AspMainTasks {
  /** Host observations; excluded from architectural checkpoints. */
  readonly stats = { tasks: 0, fallbacks: 0, commands: 0, lastFallback: '' };
  private readonly dmem = new Uint8Array(4096);
  private readonly view = new DataView(this.dmem.buffer);
  private readonly undo: { address: number; bytes: Uint8Array }[] = [];
  /** VCO, the vector carry flags. RESAMPLE's first VSUB consumes them, so a
   * task's result can depend on the flags the previous microcode left. */
  private carry = 0;
  // Per-lane working storage, reused across commands.
  private readonly lanes = new Int32Array(64);

  constructor(
    private readonly ram: Uint8Array,
    /** The RSP's vector flags; read before and written after each task. */
    private readonly vector?: { carry: number },
  ) {}

  /** True when the OSTask in DMEM is a fresh audio task for the recognized
   * code and data images. */
  recognizes(dmem: DataView): boolean {
    const type = dmem.getUint32(0xfc0, false),
      flags = dmem.getUint32(0xfc4, false),
      text = dmem.getUint32(0xfd0, false) & 0x1fffffff,
      data = dmem.getUint32(0xfd8, false) & 0x1fffffff,
      dataBytes = dmem.getUint32(0xfdc, false);
    if (type !== 2 || (flags & 1) !== 0 || dataBytes !== aspMainMicrocode.dataBytes) {
      return false;
    }
    // The boot loader's DMA aligns both RDRAM addresses down to 8 bytes.
    if ((text & 7) !== 0 || (data & 7) !== 0) {
      return false;
    }
    if (text + aspMainMicrocode.codeBytes > this.ram.length || data + dataBytes > this.ram.length) {
      return false;
    }
    return (
      fnv1a(this.ram, data, dataBytes) === aspMainMicrocode.data &&
      fnv1a(this.ram, text, aspMainMicrocode.codeBytes) === aspMainMicrocode.code
    );
  }

  /** Runs a whole recognized audio task. Returns false, with RDRAM and DMEM
   * unchanged, when the task must run on the original microcode instead. */
  run(dmem: DataView): boolean {
    if (!this.recognizes(dmem)) {
      return false;
    }
    const data = dmem.getUint32(0xfd8, false) & 0x1fffffff;
    return this.runTask(
      new Uint8Array(dmem.buffer, dmem.byteOffset, 4096),
      this.ram.subarray(data, data + aspMainMicrocode.dataBytes),
      dmem.getUint32(0xff0, false) | 0,
      dmem.getUint32(0xff4, false) | 0,
    );
  }

  /** Executes one task's command list against `live` DMEM after copying
   * `dataImage` over DMEM $000, as the boot loader does. run() passes the
   * recognized image; synthetic tests pass their own jump table and filter
   * table. Commits DMEM and RDRAM only when the whole list succeeds. */
  runTask(live: Uint8Array, dataImage: Uint8Array, list: number, bytes: number): boolean {
    this.dmem.set(live.subarray(0, 4096));
    this.dmem.set(dataImage.subarray(0, DATA), 0);
    this.carry = this.vector?.carry ?? 0;
    this.undo.length = 0;
    try {
      this.execute(list, bytes);
    } catch (error) {
      for (let i = this.undo.length - 1; i >= 0; i--) {
        this.ram.set(this.undo[i]!.bytes, this.undo[i]!.address);
      }
      this.undo.length = 0;
      if (error instanceof AudioUnsupported) {
        this.stats.fallbacks++;
        this.stats.lastFallback = error.message;
        return false;
      }
      throw error;
    }
    this.undo.length = 0;
    live.set(this.dmem);
    if (this.vector) {
      this.vector.carry = this.carry;
    }
    this.stats.tasks++;
    return true;
  }

  /** The original dispatcher: 320-byte command chunks DMA'd to $380 and read
   * from DMEM as they execute, through the data image's jump table. */
  private execute(list: number, remaining: number): void {
    // Only segment 0 is cleared: the original loop stores to the same word
    // sixteen times, so segments 1-15 keep earlier DMEM contents.
    this.store32(SEGMENTS, 0);
    let pointer = list;
    for (;;) {
      const loaded = remaining - CHUNK > 0 ? CHUNK : remaining;
      this.dma(COMMANDS, pointer, loaded - 1, false);
      let left = loaded,
        at = COMMANDS;
      do {
        const w0 = this.load32(at) | 0,
          w1 = this.load32(at + 4) | 0;
        pointer += 8;
        remaining -= 8;
        at += 8;
        left -= 8;
        this.command(w0, w1);
        this.stats.commands++;
      } while (left > 0);
      if (remaining <= 0) {
        return;
      }
    }
  }

  private command(w0: number, w1: number): void {
    const target = this.view.getUint16(0x10 + ((w0 >>> 23) & 0xfe), false) & 0xffc;
    switch (target) {
      case Handler.Noop:
        return;
      case Handler.Adpcm:
        return this.adpcm(w0, w1);
      case Handler.ClearBuffer:
        return this.clearBuffer(w0, w1);
      case Handler.EnvelopeMixer:
        return this.envelopeMixer(w0, w1);
      case Handler.Resample:
        return this.resample(w0, w1);
      case Handler.LoadBuffer:
      case Handler.SaveBuffer: {
        const count = this.load16(STATE + 4);
        if (count) {
          const save = target === Handler.SaveBuffer;
          this.dma(this.load16(STATE + (save ? 2 : 0)), this.address(w1), count - 1, save);
        }
        return;
      }
      case Handler.Segment:
        this.store32(SEGMENTS + ((w1 >>> 24) << 2), w1 & 0xffffff);
        return;
      case Handler.SetBuffer:
        return this.setBuffer(w0, w1);
      case Handler.SetVolume:
        return this.setVolume(w0, w1);
      case Handler.MoveBuffer:
        return this.moveBuffer(w0, w1);
      case Handler.LoadCodebook:
        this.dma(CODEBOOK, this.address(w1), (w0 & 0xffff) - 1, false);
        return;
      case Handler.Mixer:
        return this.mixer(w0, w1);
      case Handler.Interleave:
        return this.interleave(w1);
      case Handler.SetLoop:
        this.store32(STATE + 16, this.address(w1));
        return;
      default:
        // POLEF and anything reached through a modified or out-of-range
        // table entry stay on the original microcode.
        throw new AudioUnsupported(
          `Audio command $${(w0 >>> 24).toString(16)} (handler $${target.toString(16)}) is not implemented.`,
        );
    }
  }

  /** Segmented RDRAM address: 24-bit offset plus the segment word. Segment
   * numbers above 15 read further into DMEM, as the original LW does. */
  private address(w1: number): number {
    return ((w1 & 0xffffff) + this.load32(SEGMENTS + ((w1 >>> 24) << 2))) | 0;
  }

  private setBuffer(w0: number, w1: number): void {
    const input = w0 + BUFFERS,
      output = (w1 >>> 16) + BUFFERS;
    if ((w0 >>> 16) & 8) {
      // A_AUX: dry right, wet left and wet right buffers for ENVMIXER.
      this.store16(STATE + 14, w1 + BUFFERS);
      this.store16(STATE + 10, input);
      this.store16(STATE + 12, output);
    } else {
      this.store16(STATE, input);
      this.store16(STATE + 2, output);
      this.store16(STATE + 4, w1);
    }
  }

  private setVolume(w0: number, w1: number): void {
    const flags = w0 >>> 16;
    if (flags & 8) {
      // A_AUX: dry and wet gains.
      this.store16(STATE + 28, w0);
      this.store16(STATE + 30, w1);
    } else if (flags & 4) {
      // A_VOL: starting volume.
      this.store16(STATE + (flags & 2 ? 6 : 8), w0);
    } else {
      // Ramp target and 16.16 rate.
      const base = STATE + (flags & 2 ? 16 : 22);
      this.store16(base, w0);
      this.store16(base + 2, w1 >>> 16);
      this.store16(base + 4, w1);
    }
  }

  /** CLEARBUFF clears whole 16-byte groups (two SDVs per group). */
  private clearBuffer(w0: number, w1: number): void {
    const count = w1 & 0xffff;
    if (!count) {
      return;
    }
    const start = (w0 & 0xffff) + BUFFERS,
      bytes = Math.ceil(count / 16) * 16;
    this.writable(start, bytes);
    this.dmem.fill(0, start & 0xfff, (start & 0xfff) + bytes);
  }

  /** DMEMMOVE copies 16-byte groups, each loaded before it is stored. */
  private moveBuffer(w0: number, w1: number): void {
    const count = w1 & 0xffff;
    if (!count) {
      return;
    }
    const groups = Math.ceil(count / 16);
    let from = ((w0 & 0xffff) + BUFFERS) & 0xfff,
      to = ((w1 >>> 16) + BUFFERS) & 0xfff;
    this.readable(from, groups * 16);
    this.writable(to, groups * 16);
    for (let group = 0; group < groups; group++, from += 16, to += 16) {
      this.dmem.copyWithin(to, from, from + 16);
    }
  }

  /** INTERLEAVE: eight left and eight right samples per loop. */
  private interleave(w1: number): void {
    const count = this.load16(STATE + 4);
    if (!count) {
      return;
    }
    let output = this.load16(STATE + 2),
      right = ((w1 & 0xffff) + BUFFERS) & 0xfff,
      left = ((w1 >>> 16) + BUFFERS) & 0xfff;
    if ((left | right) & 15) {
      throw new AudioUnsupported('INTERLEAVE needs 16-byte aligned inputs.');
    }
    const loops = Math.ceil(count / 16),
      view = this.view,
      lanes = this.lanes;
    this.readable(left, loops * 16);
    this.readable(right, loops * 16);
    this.writable(output, loops * 32);
    output &= 0xfff;
    for (let loop = 0; loop < loops; loop++, left += 16, right += 16, output += 32) {
      for (let i = 0; i < 8; i++) {
        lanes[i] = view.getUint16(left + i * 2, false);
        lanes[8 + i] = view.getUint16(right + i * 2, false);
      }
      for (let i = 0; i < 8; i++) {
        this.store16(output + i * 4, lanes[i]!);
        this.store16(output + i * 4 + 2, lanes[8 + i]!);
      }
    }
  }

  /** MIXER: out = out * $7FFF + in * gain, sixteen samples per loop, with
   * the original order of loads and stores. */
  private mixer(w0: number, w1: number): void {
    const count = this.load16(STATE + 4);
    if (!count) {
      return;
    }
    let output = ((w1 & 0xffff) + BUFFERS) & 0xfff,
      input = ((w1 >>> 16) + BUFFERS) & 0xfff;
    if ((output | input) & 15) {
      throw new AudioUnsupported('MIXER needs 16-byte aligned buffers.');
    }
    const gain = signed16(w0),
      loops = Math.ceil(count / 32),
      view = this.view,
      lanes = this.lanes;
    this.readable(input, loops * 32);
    this.writable(output, loops * 32);
    // Lanes: [0,8) out low, [8,16) in low, [16,24) out high, [24,32) in high,
    // [32,40) high result. Loads that follow a store in the original loop
    // see that store; each next input half is loaded before the high store.
    for (let i = 0; i < 8; i++) {
      lanes[i] = view.getInt16(output + i * 2, false);
      lanes[8 + i] = view.getInt16(input + i * 2, false);
      lanes[16 + i] = view.getInt16(output + 16 + i * 2, false);
      lanes[24 + i] = view.getInt16(input + 16 + i * 2, false);
    }
    for (let loop = 0; ; loop++) {
      const more = loop + 1 < loops;
      for (let i = 0; i < 8; i++) {
        view.setInt16(output + i * 2, mix(lanes[i]!, lanes[8 + i]!, gain), false);
      }
      input += 32;
      for (let i = 0; i < 8; i++) {
        lanes[32 + i] = mix(lanes[16 + i]!, lanes[24 + i]!, gain);
      }
      if (more) {
        for (let i = 0; i < 8; i++) {
          lanes[8 + i] = view.getInt16(input + i * 2, false);
          lanes[24 + i] = view.getInt16(input + 16 + i * 2, false);
        }
      }
      for (let i = 0; i < 8; i++) {
        view.setInt16(output + 16 + i * 2, lanes[32 + i]!, false);
      }
      if (!more) {
        return;
      }
      output += 32;
      for (let i = 0; i < 8; i++) {
        lanes[i] = view.getInt16(output + i * 2, false);
        lanes[16 + i] = view.getInt16(output + 16 + i * 2, false);
      }
    }
  }

  /** ADPCM: 9-byte frames (scale/predictor byte, sixteen 4-bit residuals)
   * into sixteen samples each, after the 32-byte previous state. */
  private adpcm(w0: number, w1: number): void {
    const view = this.view,
      dmem = this.dmem,
      flags = w0 >>> 16,
      count = this.load16(STATE + 4),
      state = this.address(w1);
    // DMA uses the register value: bit 12 would select IMEM.
    const register = this.load16(STATE + 2);
    let input = this.load16(STATE);
    if (register & 15) {
      throw new AudioUnsupported('ADPCM needs a 16-byte aligned output.');
    }
    const frames = count ? Math.ceil(count / 32) : 0,
      output = register & 0xfff;
    this.writable(output, 32 + frames * 32);
    this.readable(input, frames * 9);
    dmem.fill(0, output, output + 32);
    if (!(flags & 1)) {
      this.dma(register, flags & 2 ? this.load32(STATE + 16) : state, 31, false);
    }
    // Previous output samples 14 and 15 seed the predictor.
    let previous6 = view.getInt16(output + 28, false),
      previous7 = view.getInt16(output + 30, false);
    let at = output + 32;
    if (frames) {
      const samples = this.lanes, // x[0..16)
        data = new Uint8Array(8),
        results = new Int32Array(8);
      let book = new Int32Array(16),
        nextBook = new Int32Array(16);
      // A header selects one of sixteen 32-byte entries from $4C0; indices
      // past the loaded codebook read on into the buffers, as on the RSP.
      const readBook = (target: Int32Array, header: number) => {
        const entry = CODEBOOK + ((header & 0xf) << 5);
        for (let i = 0; i < 16; i++) {
          target[i] = view.getInt16(entry + i * 2, false);
        }
      };
      let header = dmem[input & 0xfff]!;
      for (let i = 0; i < 8; i++) {
        data[i] = dmem[(input + 1 + i) & 0xfff]!;
      }
      readBook(book, header);
      for (let frame = 0; frame < frames; frame++) {
        const shift = 12 - (header >> 4);
        for (let i = 0; i < 8; i++) {
          const byte = data[i]!;
          let high = signed16((byte & 0xf0) << 8),
            low = signed16((byte & 0x0f) << 12);
          if (shift > 0) {
            high >>= shift;
            low >>= shift;
          }
          samples[i * 2] = high;
          samples[i * 2 + 1] = low;
        }
        // The next frame's header, residuals and codebook entry are read
        // before this frame's samples are stored (in-place decoding).
        input += 9;
        header = dmem[input & 0xfff]!;
        for (let i = 0; i < 8; i++) {
          data[i] = dmem[(input + 1 + i) & 0xfff]!;
        }
        readBook(nextBook, header);
        for (let half = 0; half < 2; half++) {
          const base = half * 8;
          for (let i = 0; i < 8; i++) {
            let sum = book[i]! * previous6 + book[8 + i]! * previous7 + samples[base + i]! * 2048;
            for (let k = 0; k < i; k++) {
              sum += book[8 + i - 1 - k]! * samples[base + k]!;
            }
            // VSAR high/middle, then x32 and the high slice: bits 42..27 of
            // the 48-bit sum, which wraps at 32 bits of whole units.
            results[i] = clamp16((sum | 0) >> 11);
          }
          for (let i = 0; i < 8; i++) {
            view.setInt16((at + base * 2 + i * 2) & 0xfff, results[i]!, false);
          }
          previous6 = results[6]!;
          previous7 = results[7]!;
        }
        [book, nextBook] = [nextBook, book];
        at += 32;
      }
    }
    // The last 32 bytes written become the next call's state.
    this.dma(register + frames * 32, state, 31, true);
  }

  /** RESAMPLE: four-tap polyphase interpolation from the data image's
   * 64-phase table, with 4 history samples and the fractional position
   * carried in a 32-byte state. */
  private resample(w0: number, w1: number): void {
    const view = this.view,
      flags = w0 >>> 16,
      pitch = w0 & 0xffff,
      inputStart = this.load16Signed(STATE),
      count = this.load16Signed(STATE + 4),
      state = this.address(w1);
    let output = this.load16Signed(STATE + 2);
    this.store32(SCRATCH + 64, state);
    if (flags & 1) {
      this.store16(SCRATCH + 8, 0);
      this.dmem.fill(0, SCRATCH, SCRATCH + 8);
    } else {
      this.dma(SCRATCH, state, 31, false);
    }
    let base = inputStart;
    if (flags & 2) {
      const back = this.load16Signed(SCRATCH + 10);
      this.writable(base - 16, 16);
      this.dmem.copyWithin((base - 16) & 0xfff, SCRATCH + 16, SCRATCH + 24);
      this.dmem.copyWithin((base - 8) & 0xfff, SCRATCH + 24, SCRATCH + 32);
      base -= back;
    }
    base -= 8;
    const fraction0 = this.load16(SCRATCH + 8);
    this.writable(base, 8);
    this.dmem.copyWithin(base & 0xfff, SCRATCH, SCRATCH + 8);
    const loops = count > 0 ? Math.ceil(count / 16) : 1;
    if ((output & 15) !== 0) {
      throw new AudioUnsupported('RESAMPLE needs a 16-byte aligned output.');
    }
    this.writable(output, loops * 16);
    output &= 0xfff;
    const base16 = signed16(base),
      sampleAddress = this.lanes, // [0,8)
      filterAddress = new Int32Array(8),
      whole = new Int32Array(8),
      part = new Int32Array(8);
    // First positions: frac + k * 2 * pitch. VSUB consumes the incoming VCO
    // borrow bits once; the second VSUB sees them cleared.
    for (let k = 0; k < 8; k++) {
      const step = 2 * k - ((this.carry >> k) & 1);
      this.position(k, fraction0 + step * pitch, base16, whole, part, sampleAddress, filterAddress);
    }
    this.carry = 0;
    let lastWhole = whole[7]!,
      lastPart = part[7]!;
    const results = new Int32Array(8),
      taps = new Int32Array(32),
      coefficients = new Int32Array(32);
    for (let loop = 0; loop < loops; loop++) {
      for (let k = 0; k < 8; k++) {
        const samples = sampleAddress[k]! & 0xfff,
          filter = filterAddress[k]! & 0xfff;
        if (samples + 8 > SCRATCH) {
          throw new AudioUnsupported('RESAMPLE input reaches DMEM scratch.');
        }
        for (let tap = 0; tap < 4; tap++) {
          taps[k * 4 + tap] = view.getInt16(samples + tap * 2, false);
          coefficients[k * 4 + tap] = view.getInt16((filter + tap * 2) & 0xfff, false);
        }
      }
      // Next positions continue from lane 7: whole:part + (k + 1) * 2 * pitch.
      const origin = lastWhole * 65536 + lastPart;
      for (let k = 0; k < 8; k++) {
        this.position(
          k,
          origin + (2 * k + 2) * pitch,
          base16,
          whole,
          part,
          sampleAddress,
          filterAddress,
        );
      }
      lastWhole = whole[7]!;
      lastPart = part[7]!;
      for (let k = 0; k < 8; k++) {
        const t = k * 4;
        const pair0 = clamp16(
            fractional(taps[t]!, coefficients[t]!) + fractional(taps[t + 1]!, coefficients[t + 1]!),
          ),
          pair1 = clamp16(
            fractional(taps[t + 2]!, coefficients[t + 2]!) +
              fractional(taps[t + 3]!, coefficients[t + 3]!),
          );
        results[k] = clamp16(pair0 + pair1);
      }
      for (let k = 0; k < 8; k++) {
        view.setInt16(output + k * 2, results[k]!, false);
      }
      output += 16;
    }
    // The last sample/filter address lists stay in scratch ($FB0, $FC0).
    for (let k = 0; k < 8; k++) {
      this.store16(SCRATCH + 32 + k * 2, sampleAddress[k]!);
      this.store16(SCRATCH + 48 + k * 2, filterAddress[k]!);
    }
    // Save the next position's fraction, its four samples and the 16 bytes
    // that end at the next 16-byte boundary after them, then the state.
    this.store16(SCRATCH + 8, part[0]!);
    let next = signed16(sampleAddress[0]!);
    this.readable(next, 8);
    this.dmem.copyWithin(SCRATCH, next & 0xfff, (next & 0xfff) + 8);
    next += 8;
    let misalignment = (next - this.load16Signed(STATE)) & 15;
    next -= misalignment;
    if (misalignment) {
      misalignment = 16 - misalignment;
    }
    this.store16(SCRATCH + 10, misalignment);
    this.readable(next, 16);
    this.dmem.copyWithin(SCRATCH + 16, next & 0xfff, (next & 0xfff) + 16);
    this.dma(SCRATCH, this.load32(SCRATCH + 64), 31, true);
  }

  /** One lane's position from its accumulator: VMADM integer part, VMADN
   * fraction, then the sample and filter-phase DMEM addresses. */
  private position(
    lane: number,
    accumulator: number,
    base16: number,
    whole: Int32Array,
    part: Int32Array,
    sampleAddress: Int32Array,
    filterAddress: Int32Array,
  ): void {
    const high = Math.floor(accumulator / 65536),
      integer = clamp16(high),
      low = fraction(accumulator);
    whole[lane] = integer;
    part[lane] = low;
    sampleAddress[lane] = (base16 + (integer & 0xffff) * 2) & 0xffff;
    filterAddress[lane] = (0xc0 + (low >>> 10) * 8) & 0xffff;
  }

  /** ENVMIXER: per-lane exponential volume ramps (16.16 volume times a 16.16
   * rate every eight samples, clamped at the target), applied to dry and wet
   * gains for both channels, with an 80-byte state. */
  private envelopeMixer(w0: number, w1: number): void {
    const view = this.view,
      lanes = this.lanes,
      flags = w0 >>> 16,
      init = (flags & 1) !== 0,
      state = this.address(w1);
    // Parameters: targets, rates (high, low), dry and wet gains.
    const parameters = new Int32Array(8);
    for (let i = 0; i < 8; i++) {
      parameters[i] = view.getUint16(STATE + 16 + i * 2, false);
    }
    // Volumes as integer (v20/v18) and fractional (v21/v19) lanes.
    const leftWhole = new Int32Array(8),
      leftPart = new Int32Array(8),
      rightWhole = new Int32Array(8),
      rightPart = new Int32Array(8);
    if (!init) {
      this.dma(SCRATCH, state, 79, false);
      for (let i = 0; i < 8; i++) {
        leftWhole[i] = view.getUint16(SCRATCH + i * 2, false);
        leftPart[i] = view.getUint16(SCRATCH + 16 + i * 2, false);
        rightWhole[i] = view.getUint16(SCRATCH + 32 + i * 2, false);
        rightPart[i] = view.getUint16(SCRATCH + 48 + i * 2, false);
        parameters[i] = view.getUint16(SCRATCH + 64 + i * 2, false);
      }
    }
    let input = this.load16Signed(STATE),
      dryLeft = this.load16Signed(STATE + 2),
      dryRight = this.load16Signed(STATE + 10),
      wetLeft = this.load16Signed(STATE + 12),
      wetRight = this.load16Signed(STATE + 14),
      remaining = this.load16Signed(STATE + 4),
      wetStep = 16;
    if (!(flags & 8)) {
      wetLeft = wetRight = SCRATCH + 80;
      wetStep = 0;
    }
    const leftTarget = parameters[0]!,
      leftRateHigh = signed16(parameters[1]!),
      leftRateLow = parameters[2]!,
      rightTarget = parameters[3]!,
      rightRateHigh = signed16(parameters[4]!),
      rightRateLow = parameters[5]!,
      dry = signed16(parameters[6]!),
      wet = signed16(parameters[7]!);
    const blocks = (init ? 1 : 0) + Math.max(1, Math.ceil((remaining - (init ? 16 : 0)) / 16));
    for (const buffer of [input, dryLeft, dryRight]) {
      if (buffer & 15) {
        throw new AudioUnsupported('ENVMIXER needs 16-byte aligned buffers.');
      }
    }
    this.readable(input, blocks * 16);
    this.writable(dryLeft, blocks * 16);
    this.writable(dryRight, blocks * 16);
    if (wetStep) {
      if ((wetLeft | wetRight) & 15) {
        throw new AudioUnsupported('ENVMIXER needs 16-byte aligned buffers.');
      }
      this.writable(wetLeft, blocks * 16);
      this.writable(wetRight, blocks * 16);
    }
    // Lane scratch: [0,8) input, [8,16) dry, [16,24) wet, [24,32) dry gain,
    // [32,40) wet gain, [40,48) second dry, [48,56) second wet.
    const load = (address: number, at: number) => {
      const a = address & 0xfff;
      for (let i = 0; i < 8; i++) {
        lanes[at + i] = view.getInt16(a + i * 2, false);
      }
    };
    const store = (address: number, at: number) => {
      const a = address & 0xfff;
      for (let i = 0; i < 8; i++) {
        view.setInt16(a + i * 2, lanes[at + i]!, false);
      }
    };
    const gains = (volume: Int32Array) => {
      for (let i = 0; i < 8; i++) {
        const v = signed16(volume[i]!);
        lanes[24 + i] = fractional(v, dry);
        lanes[32 + i] = fractional(v, wet);
      }
    };
    const apply = (dryAt: number, wetAt: number) => {
      for (let i = 0; i < 8; i++) {
        const x = lanes[i]!;
        lanes[dryAt + i] = mix(lanes[dryAt + i]!, x, lanes[24 + i]!);
        lanes[wetAt + i] = mix(lanes[wetAt + i]!, x, lanes[32 + i]!);
      }
    };
    if (init) {
      this.startRamp(
        signed16(this.load16(STATE + 6)),
        leftRateHigh,
        leftRateLow,
        leftWhole,
        leftPart,
      );
      this.clampRamp(leftWhole, leftTarget, leftRateHigh);
      load(input, 0);
      load(dryLeft, 8);
      load(wetLeft, 16);
      gains(leftWhole);
      apply(8, 16);
      store(dryLeft, 8);
      store(wetLeft, 16);
      load(dryRight, 8);
      load(wetRight, 16);
      this.startRamp(
        signed16(this.load16(STATE + 8)),
        rightRateHigh,
        rightRateLow,
        rightWhole,
        rightPart,
      );
      this.clampRamp(rightWhole, rightTarget, rightRateHigh);
      gains(rightWhole);
      apply(8, 16);
      store(dryRight, 8);
      store(wetRight, 16);
      remaining -= 16;
      input += 16;
      dryLeft += 16;
      dryRight += 16;
      wetLeft += wetStep;
      wetRight += wetStep;
    }
    this.stepRamp(leftWhole, leftPart, leftRateHigh, leftRateLow);
    for (;;) {
      load(input, 0);
      if (leftRateHigh > 0 && this.carry !== 0) {
        // VCL would read stale VCO/VCC flags from before this command.
        throw new AudioUnsupported('ENVMIXER would clamp with inherited vector flags.');
      }
      this.clampRamp(leftWhole, leftTarget, leftRateHigh);
      this.carry = 0;
      this.stepRamp(rightWhole, rightPart, rightRateHigh, rightRateLow);
      load(dryLeft, 8);
      load(wetLeft, 16);
      for (let i = 0; i < 8; i++) {
        view.setUint16(SCRATCH + i * 2, leftWhole[i]!, false);
        view.setUint16(SCRATCH + 16 + i * 2, leftPart[i]!, false);
      }
      gains(leftWhole);
      apply(8, 16);
      load(dryRight, 40);
      load(wetRight, 48);
      store(dryLeft, 8);
      this.clampRamp(rightWhole, rightTarget, rightRateHigh);
      store(wetLeft, 16);
      this.stepRamp(leftWhole, leftPart, leftRateHigh, leftRateLow);
      gains(rightWhole);
      apply(40, 48);
      remaining -= 16;
      dryLeft += 16;
      wetLeft += wetStep;
      input += 16;
      store(dryRight, 40);
      dryRight += 16;
      store(wetRight, 48);
      if (remaining <= 0) {
        break;
      }
      wetRight += wetStep;
    }
    for (let i = 0; i < 8; i++) {
      view.setUint16(SCRATCH + 32 + i * 2, rightWhole[i]!, false);
      view.setUint16(SCRATCH + 48 + i * 2, rightPart[i]!, false);
      view.setUint16(SCRATCH + 64 + i * 2, parameters[i]!, false);
    }
    this.dma(SCRATCH, state, 79, true);
  }

  /** First block after A_INIT: interpolate from the starting volume towards
   * volume * rate across the eight lanes (fractions 1/8 ... 8/8). */
  private startRamp(
    volume: number,
    rateHigh: number,
    rateLow: number,
    whole: Int32Array,
    part: Int32Array,
  ): void {
    const product = volume * rateLow + volume * rateHigh * 65536,
      high = Math.floor(product / 65536),
      deltaLow = fraction(product),
      // VSUBC against zero never borrows, so VSUB subtracts without carry.
      deltaHigh = clamp16(clamp16(high) - volume);
    for (let i = 0; i < 8; i++) {
      const f = rampFractions[i]!,
        accumulator = Math.floor((f * deltaLow) / 65536) + f * deltaHigh + volume * 65536;
      whole[i] = clamp16(Math.floor(accumulator / 65536)) & 0xffff;
      part[i] = fraction(accumulator);
    }
    this.carry = 0;
  }

  /** Next block: (whole.part) * (rateHigh.rateLow), dropping the low x low
   * product's fraction (VMUDL), per lane. */
  private stepRamp(whole: Int32Array, part: Int32Array, rateHigh: number, rateLow: number): void {
    for (let i = 0; i < 8; i++) {
      const v = signed16(whole[i]!),
        f = part[i]!,
        accumulator =
          Math.floor((f * rateLow) / 65536) + v * rateLow + f * rateHigh + v * rateHigh * 65536;
      whole[i] = clamp16(Math.floor(accumulator / 65536)) & 0xffff;
      part[i] = fraction(accumulator);
    }
  }

  /** Rising ramps (positive rate high half) stop at the target with an
   * unsigned VCL minimum; others with a signed VGE maximum. */
  private clampRamp(whole: Int32Array, target: number, rateHigh: number): void {
    if (rateHigh > 0) {
      for (let i = 0; i < 8; i++) {
        if (whole[i]! >= target) {
          whole[i] = target;
        }
      }
    } else {
      const t = signed16(target);
      for (let i = 0; i < 8; i++) {
        if (signed16(whole[i]!) < t) {
          whole[i] = target;
        }
      }
    }
  }

  /** SP DMA as the microcode issues it: 8-byte aligned addresses, length
   * rounded up to 8 bytes, DMEM addresses wrapping within 4 KiB. */
  private dma(memory: number, dram: number, length: number, write: boolean): void {
    const bytes = ((length & 0xfff) | 7) + 1,
      rows = ((length >>> 12) & 255) + 1;
    memory &= 0x1ff8;
    dram &= 0xfffff8;
    if (memory & 0x1000 || rows !== 1) {
      throw new AudioUnsupported('Audio DMA outside the single-row DMEM model.');
    }
    if (dram + bytes > this.ram.length) {
      throw new AudioUnsupported('Audio DMA beyond RDRAM.');
    }
    if (write) {
      this.undo.push({ address: dram, bytes: this.ram.slice(dram, dram + bytes) });
      if (memory + bytes <= 4096) {
        this.ram.set(this.dmem.subarray(memory, memory + bytes), dram);
      } else {
        for (let i = 0; i < bytes; i++) {
          this.ram[dram + i] = this.dmem[(memory + i) & 0xfff]!;
        }
      }
      return;
    }
    // Command chunks, the codebook and the RESAMPLE/ENVMIXER states have
    // fixed homes; buffers must stay clear of the data image and scratch.
    if (memory === SCRATCH) {
      if (bytes > 80) {
        throw new AudioUnsupported('Audio state DMA larger than its scratch.');
      }
    } else if (memory !== COMMANDS && memory !== CODEBOOK) {
      this.writable(memory, bytes);
    } else if (memory + bytes > SCRATCH) {
      throw new AudioUnsupported('Audio DMA reaches DMEM scratch.');
    }
    this.dmem.set(this.ram.subarray(dram, dram + bytes), memory);
  }

  /** Buffers written by commands stay between the data image and scratch. */
  private writable(start: number, bytes: number): void {
    const s = start & 0xfff;
    if (s < DATA || s + bytes > SCRATCH) {
      throw new AudioUnsupported('Audio buffer outside the DMEM buffer area.');
    }
  }
  /** Buffers read by commands do not reach scratch, whose contents follow
   * the original instruction order only at command boundaries. */
  private readable(start: number, bytes: number): void {
    if ((start & 0xfff) + bytes > SCRATCH) {
      throw new AudioUnsupported('Audio buffer reaches DMEM scratch.');
    }
  }

  private load16(address: number): number {
    const dmem = this.dmem;
    return (dmem[address & 0xfff]! << 8) | dmem[(address + 1) & 0xfff]!;
  }
  private load16Signed(address: number): number {
    return signed16(this.load16(address));
  }
  private load32(address: number): number {
    return ((this.load16(address) << 16) | this.load16(address + 2)) >>> 0;
  }
  private store16(address: number, value: number): void {
    this.dmem[address & 0xfff] = (value >>> 8) & 255;
    this.dmem[(address + 1) & 0xfff] = value & 255;
  }
  private store32(address: number, value: number): void {
    this.store16(address, value >>> 16);
    this.store16(address + 2, value);
  }
}
