import { ExecutionGap } from '../../runtime/mos6502.js';
import { renderC64, type SpriteLine, type CharacterLine } from './render.js';
import type { C64SystemBus } from './system.js';

interface SpriteSequence {
  active: boolean;
  row: number;
  repeat: boolean;
  data: number[];
}
// PAL pointer/data fetch groups: sprites 0–2 at the end of the previous
// line, sprites 3–7 at the beginning of this line. Each three-byte fetch is
// grouped at its pointer access; instruction-level bus phases remain approximate.
const PHASES = [1, 3, 5, 7, 9, 14, 55, 58, 60, 62] as const;

/** VIC display state, independent of the CPU's current register snapshot.
 * A Y write prepares the next reuse without truncating an active 21-row sprite.
 * Character codes/colours are retained between bad lines. See Bauer's VIC-II
 * article §§3.6.3, 3.7.2, 3.8.1 (linked in LEMMINGS-BROWSER.md).
 * The player supplies VIC read-ready waits; capture groups still approximate individual fetch phases. */
export class C64RasterDisplay {
  readonly pixels = new Uint8Array(320 * 200 * 4);
  private readonly foreground = new Uint8Array(320 * 200);
  private line: number;
  private phase = 0;
  private readonly sprites: SpriteSequence[] = Array.from({ length: 8 }, () => ({
    active: false,
    row: 0,
    repeat: false,
    data: [0, 0, 0],
  }));
  private readonly characters = new Uint8Array(40);
  private readonly colours = new Uint8Array(40);
  private row = 0;
  private base = 0;
  private display = false;
  private den = false;
  frames = 0;
  constructor(
    bus: C64SystemBus,
    readonly render = true,
  ) {
    this.line = Math.floor(bus.vic.cycles / 63) + 1;
  }
  /** BA falls three cycles ahead of VIC second-phase accesses. RDY stalls
   * CPU reads; writes can finish. PAL sprite slots wrap across line boundaries. */
  cpuReadBlocked(bus: C64SystemBus): boolean {
    const cycle = (bus.vic.cycles % 63) + 1,
      raster = bus.vic.raster,
      r = bus.vic.registers;
    if (
      this.den &&
      raster >= 48 &&
      raster <= 247 &&
      (raster & 7) === (r[0x11]! & 7) &&
      cycle >= 12 &&
      cycle <= 54
    ) {
      return true;
    }
    for (let sprite = 0; sprite < 8; sprite++) {
      if (!this.sprites[sprite]!.active) {
        continue;
      }
      const fetch = sprite < 3 ? 58 + sprite * 2 : 1 + (sprite - 3) * 2;
      const relative = (cycle - fetch + 63) % 63;
      if (relative <= 1 || relative >= 60) {
        return true;
      }
    }
    return false;
  }
  capture(bus: C64SystemBus): void {
    const current = bus.vic.cycles;
    if (current - this.line * 63 > 312 * 63) {
      throw new Error('Raster capture missed more than one PAL frame.');
    }
    const read = (address: number): number => {
      address &= 65535;
      if (!bus.known[address]) {
        throw new ExecutionGap(
          'video-memory',
          address,
          'The display reads an unrecovered RAM byte.',
        );
      }
      return bus.bytes[address]!;
    };
    while (this.line * 63 + PHASES[this.phase]! - 1 <= current) {
      const raster = this.line % 312,
        cycle = PHASES[this.phase]!,
        r = bus.vic.registers;
      const bank = (~bus.cia2.read(0) & 3) * 0x4000,
        screen = bank + ((r[0x18]! & 0xf0) << 6);
      if (cycle === 1) {
        if (raster === 0) {
          this.base = 0;
          this.row = 0;
          this.display = false;
          this.den = false;
        }
        if (raster === 48) {
          this.den = !!(r[0x11]! & 16);
        }
      }
      if (cycle === 14) {
        if (this.den && raster >= 48 && raster <= 247 && (raster & 7) === (r[0x11]! & 7)) {
          this.row = 0;
          this.display = true;
          // Group the forty c-accesses here. The retained codes/colours matter
          // even though per-column fetch timing is outside this approximation.
          for (let column = 0; this.render && column < 40; column++) {
            this.characters[column] = read(screen + ((this.base + column) & 1023));
            this.colours[column] = bus.colour[(this.base + column) & 1023]!;
          }
        }
        const y = raster - 51;
        if (this.render && y >= 0 && y < 200) {
          const spriteLines: SpriteLine[] = this.sprites.flatMap((sequence, index) =>
            sequence.active ? [{ index, data: sequence.data }] : [],
          );
          const characterLine: CharacterLine = {
            characters: this.characters,
            colours: this.colours,
            row: this.row,
            base: this.base,
            active: this.display,
          };
          renderC64(
            { ram: bus.bytes, known: bus.known, colour: bus.colour, registers: r, bank },
            {
              start: y,
              end: y + 1,
              pixels: this.pixels,
              foreground: this.foreground,
              spriteLines,
              characterLine,
            },
          );
        }
        if (this.display) {
          if (this.row === 7) {
            this.display = false;
            this.base = (this.base + 40) & 1023;
          } else {
            this.row++;
          }
        }
        for (let sprite = 0; sprite < 8; sprite++) {
          const sequence = this.sprites[sprite]!;
          if (!sequence.active) {
            continue;
          }
          if (r[0x17]! & (1 << sprite) && !sequence.repeat) {
            sequence.repeat = true;
          } else {
            sequence.repeat = false;
            if (++sequence.row === 21) {
              sequence.active = false;
            }
          }
        }
      }
      if (cycle === 55) {
        for (let sprite = 0; sprite < 8; sprite++) {
          const sequence = this.sprites[sprite]!;
          if (
            !sequence.active &&
            r[0x15]! & (1 << sprite) &&
            (raster & 255) === r[sprite * 2 + 1]
          ) {
            sequence.active = true;
            sequence.row = 0;
            sequence.repeat = false;
          }
        }
      }
      const sprite = cycle <= 9 ? (cycle - 1) / 2 + 3 : cycle >= 58 ? (cycle - 58) / 2 : -1;
      if (sprite >= 0) {
        const sequence = this.sprites[sprite]!;
        if (this.render && sequence.active) {
          const pointer = bank + read(screen + 0x3f8 + sprite) * 64 + sequence.row * 3;
          sequence.data = [read(pointer), read(pointer + 1), read(pointer + 2)];
        }
      }
      if (++this.phase === PHASES.length) {
        this.phase = 0;
        this.line++;
        if (raster === 311) {
          this.frames++;
        }
      }
    }
  }
}
