import { ExecutionGap, Machine } from '../../runtime/mos6502.js';
/** Register initialisation data is also read by the game's own restore routine. */
export function vicStartupRegisters(): Uint8Array {
  const registers = new Uint8Array(47);
  registers.set([0x9b, 0x37, 0, 0, 0, 8, 0, 0x14, 15], 0x11);
  registers.set([14, 6, 1, 2, 3, 4, 0, 1, 2, 3, 4, 5, 6, 7, 0x4c], 0x20);
  return registers;
}
/** Readable implementations of the specific KERNAL contracts reached by a title.
 * No ROM image is embedded. Entry addresses preserve links to the documented
 * routines; services make their preconditions and CPU timing explicit. */
export class KernalServices {
  readonly calls: {
    address: number;
    name: string;
    pcAfter: number;
  }[] = [];
  characterInput: () => number = () => 0;
  private finish(
    s: Machine,
    address: number,
    name: string,
    cycles: number,
    instructions: number,
  ): void {
    s.pc = ((s.pop() | (s.pop() << 8)) + 1) & 65535;
    s.cycles += cycles;
    s.instructions += instructions;
    this.calls.push({ address, name, pcAfter: s.pc });
    if (this.calls.length > 128) {
      this.calls.shift();
    }
  }
  restoreVectors(s: Machine): void {
    const vectors = [
      0xea31, 0xfe66, 0xfe47, 0xf34a, 0xf291, 0xf20e, 0xf250, 0xf333, 0xf157, 0xf1ca, 0xf6ed,
      0xf13e, 0xf32f, 0xfe66, 0xf4a5, 0xf5ed,
    ];
    s.write(0xc3, 0x30);
    s.write(0xc4, 0xfd);
    for (let index = 31; index >= 0; index--) {
      const word = vectors[index >>> 1]!,
        value = index & 1 ? word >>> 8 : word & 255;
      s.write(0xfd30 + index, value);
      s.write(0x314 + index, value);
    }
    s.a = 0x31;
    s.x = 0x30;
    s.y = s.nz(255);
    s.flag(1, false);
    this.finish(s, 0xfd15, 'restoreVectors', 883, 231);
  }
  initializeIo(s: Machine): void {
    for (const address of [0xdc0d, 0xdd0d, 0xdc00]) {
      s.write(address, 0x7f);
    }
    for (const address of [0xdc0e, 0xdd0e, 0xdc0f, 0xdd0f]) {
      s.write(address, 8);
    }
    for (const address of [0xdc03, 0xdd03, 0xd418]) {
      s.write(address, 0);
    }
    s.write(0xdc02, 255);
    s.write(0xdd00, 7);
    s.write(0xdd02, 0x3f);
    s.write(1, 0xe7);
    s.write(0, 0x2f);
    this.startPalTimer(s);
    s.x = 255;
    // Functional startup contract. Timing of this composite is approximate.
    this.finish(s, 0xfda3, 'initializeIo', 160, 45);
  }
  startPalTimer(s: Machine): void {
    if (s.read(0x2a6) !== 1) {
      throw new ExecutionGap('timing-profile', s.pc, 'Only PAL startup timing is implemented.');
    }
    s.write(0xdc04, 0x25);
    s.write(0xdc05, 0x40);
    s.write(0xdc0d, 0x81);
    s.write(0xdc0e, (s.read(0xdc0e) & 128) | 17);
    s.a = s.nz(s.read(0xdd00) | 16);
    s.write(0xdd00, s.a);
  }
  initializeEditor(s: Machine, video: boolean): void {
    const entry = s.pc;
    if (video) {
      s.write(0x99, 0);
      s.write(0x9a, 3);
      const defaults = vicStartupRegisters();
      for (let r = 46; r >= 0; r--) {
        s.write(0xd000 + r, defaults[r]!);
      }
    }
    for (const [address, value] of [
      [0x291, 0],
      [0xcf, 0],
      [0x28f, 0x48],
      [0x290, 0xeb],
      [0x289, 10],
      [0x28c, 10],
      [0x286, 14],
      [0x28b, 4],
      [0xcd, 12],
      [0xcc, 12],
    ]) {
      s.write(address!, value!);
    }
    this.clearScreen(s);
    s.cycles += 100;
    s.instructions += 24;
    if (entry === 0xff5b) {
      this.startPalTimer(s);
      s.cycles += 100;
      s.instructions += 24;
    }
    this.calls.push({ address: entry, name: 'initializeEditor', pcAfter: s.pc });
  }
  clearScreen(s: Machine): void {
    const page = s.read(0x288),
      colour = s.read(0x286);
    if (s.p & 8 || page < 4 || page > 0x9c || page & 3) {
      throw new ExecutionGap(
        'kernal-precondition',
        s.pc,
        'Screen clear needs binary arithmetic and a supported, aligned RAM screen page.',
      );
    }
    // The screen editor stores one high-byte entry per physical 40-column row.
    // Bit 7 marks a new logical line. There is one extra row for line wrapping.
    for (let row = 0; row <= 25; row++) {
      s.write(0xd9 + row, (page + Math.floor((row * 40) / 256)) | 128);
    }
    s.write(0xf3, 255);
    // Preserve the stack effects of the editor's nested helper calls as well as
    // its visible screen. The literal addresses identify the documented calls.
    const helper = (returnTo: number, body: () => void): void => {
      s.push((returnTo - 1) >>> 8);
      s.push((returnTo - 1) & 255);
      body();
      s.pop();
      s.pop();
    };
    const pointAtRow = (row: number): void => {
      s.write(0xd1, (row * 40) & 255);
      s.write(0xd2, page | (((row * 40) >>> 8) & 3));
    };
    const pointAtColour = (): void => {
      s.write(0xf3, s.read(0xd1));
      s.write(0xf4, 0xd8 | (s.read(0xd2) & 3));
    };
    for (let row = 24; row >= 0; row--) {
      helper(0xe563, () => {
        helper(0xea04, () => pointAtRow(row));
        helper(0xea07, pointAtColour);
        for (let column = 39; column >= 0; column--) {
          helper(0xea0a, () => s.write(0xd800 + row * 40 + column, colour));
          s.write((page << 8) + row * 40 + column, 0x20);
        }
      });
    }
    // HOME, then rebuild the character and colour pointers for row zero.
    s.write(0xd3, 0);
    s.write(0xd6, 0);
    helper(0xe57f, () => pointAtRow(0));
    s.write(0xd5, 39);
    pointAtColour();
    s.x = 1;
    s.y = page | 128;
    s.a = 0xd8;
    s.flag(1, true);
    s.nz(s.a);
    s.pc = ((s.pop() | (s.pop() << 8)) + 1) & 65535;
    // Counts derived from the documented binary-mode instruction path, including
    // the nine ECF0,X page crossings; device DMA and IRQ preemption are excluded.
    s.instructions += 8747;
    s.cycles += 37541;
    this.calls.push({ address: 0xe544, name: 'clearScreen', pcAfter: s.pc });
  }
  /** Functional screen-editor contract for the direct $E716 entry reached by
   * Elite's release menu. Register/stack behavior follows E716/E6A8; editing,
   * insert mode, 80-column logical lines and exact service timing are excluded. */
  outputCharacter(s: Machine): void {
    if (s.p & 8 || s.read(0xd8) || s.read(0xd5) !== 39) {
      throw new ExecutionGap(
        'kernal-editor',
        s.pc,
        'Character output requires binary mode, no insert and a 40-column line.',
      );
    }
    const character = s.a,
      x = s.x,
      y = s.y,
      page = s.read(0x288);
    if (page < 4 || page > 0x9c || page & 3) {
      throw new ExecutionGap('kernal-editor', s.pc, 'Unsupported screen page.');
    }
    s.push(character);
    s.write(0xd7, character);
    s.push(x);
    s.push(y);
    s.write(0xd0, 0);
    let row = s.read(0xd6),
      column = s.read(0xd3);
    if (row > 24 || column > 39) {
      throw new ExecutionGap(
        'kernal-editor',
        s.pc,
        'Cursor is outside the supported physical screen.',
      );
    }
    const colourCodes = [
      0x90, 5, 0x1c, 0x9f, 0x9c, 0x1e, 0x1f, 0x9e, 0x81, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b,
    ];
    const colour = colourCodes.indexOf(character);
    if (colour >= 0) {
      s.write(0x286, colour);
    } else if (character === 13 || character === 0x8d) {
      row++;
      column = 0;
      s.write(0xd4, 0);
    } else if (character === 0x13) {
      row = 0;
      column = 0;
    } else if (character === 0x93) {
      for (let offset = 0; offset < 1000; offset++) {
        s.write(page * 256 + offset, 32);
        s.write(0xd800 + offset, s.read(0x286));
      }
      row = 0;
      column = 0;
    } else if (character === 0x12 || character === 0x92) {
      s.write(0xc7, character === 0x12 ? 0x12 : 0);
    } else if (character === 0x11) {
      row++;
    } else if (character === 0x91) {
      row = Math.max(0, row - 1);
    } else if (character === 0x1d) {
      column++;
    } else if (character === 0x9d) {
      column = Math.max(0, column - 1);
    } else {
      const low = character & 127;
      if (low < 32) {
        throw new ExecutionGap(
          'kernal-character',
          s.pc,
          `Unimplemented screen control $${character.toString(16)}.`,
        );
      }
      let screen =
        character < 128
          ? character < 96
            ? character & 63
            : character & 0xdf
          : (low === 127 ? 0x5e : low) | 0x40;
      if (s.read(0xc7)) {
        screen |= 128;
      }
      if (character === 34) {
        s.write(0xd4, s.read(0xd4) ^ 1);
      }
      s.write(page * 256 + row * 40 + column, screen);
      s.write(0xd800 + row * 40 + column, s.read(0x286));
      column++;
    }
    if (column >= 40) {
      column = 0;
      row++;
    }
    if (row >= 25) {
      throw new ExecutionGap(
        'kernal-scroll',
        s.pc,
        'Screen scrolling is outside this startup service.',
      );
    }
    s.write(0xd3, column);
    s.write(0xd6, row);
    s.write(0xd1, (row * 40) & 255);
    s.write(0xd2, page + ((row * 40) >>> 8));
    s.write(0xf3, (row * 40) & 255);
    s.write(0xf4, 0xd8 + ((row * 40) >>> 8));
    s.y = s.pop();
    s.x = s.pop();
    s.a = s.nz(s.pop());
    s.flag(1, false);
    s.flag(4, false);
    this.finish(s, 0xe716, 'outputCharacter', 100, 30);
  }
  dispatch(s: Machine): boolean {
    if (s.pc === 0xe716) {
      this.outputCharacter(s);
      return true;
    }
    if (s.pc === 0xff5e) {
      // The menu has already restored VIC registers and enters the timing tail
      // directly. Advance to line zero before the PAL timer setup. Service bus
      // timing remains functional; sub-instruction sampling is not modelled.
      const frameCycle = s.cycles % (63 * 312);
      s.cycles += frameCycle < 63 ? 0 : 63 * 312 - frameCycle;
      s.write(0x2a6, 1);
      this.startPalTimer(s);
      this.finish(s, 0xff5e, 'finishVideoTimingSetup', 100, 24);
      return true;
    }
    if (s.pc === 0xffba) {
      s.write(0xb8, s.a);
      s.write(0xba, s.x);
      s.write(0xb9, s.y);
      this.finish(s, 0xffba, 'setFileParameters', 18, 5);
      return true;
    }
    if (s.pc === 0xffbd) {
      s.write(0xb7, s.a);
      s.write(0xbb, s.x);
      s.write(0xbc, s.y);
      this.finish(s, 0xffbd, 'setFilename', 18, 5);
      return true;
    }
    if (s.pc === 0xe544) {
      this.clearScreen(s);
      return true;
    }
    if (s.pc === 0xfd15) {
      this.restoreVectors(s);
      return true;
    }
    if (s.pc === 0xfda3) {
      this.initializeIo(s);
      return true;
    }
    if ([0xe51b, 0xe518, 0xff5b].includes(s.pc)) {
      this.initializeEditor(s, s.pc !== 0xe51b);
      return true;
    }
    if ([0xffe4, 0xf13e, 0xf142].includes(s.pc)) {
      const entry = s.pc;
      s.a = s.nz(this.characterInput());
      s.flag(1, false);
      this.finish(s, entry, 'getCharacter', 40, 10);
      return true;
    }
    return false;
  }
}
