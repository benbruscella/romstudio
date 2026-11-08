/** MIPS Interface interrupt state. Writes to the mask register are paired
 * clear/set commands; they are not the mask value returned by a read. */
export class N64Interrupts {
  pending = 0;
  mask = 0;
  mode = 0;

  get asserted(): boolean {
    return (this.pending & this.mask) !== 0;
  }

  writeMask(commands: number): void {
    for (let bit = 0; bit < 6; bit++) {
      if ((commands & (1 << (bit * 2))) !== 0) {
        this.mask &= ~(1 << bit);
      }
      if ((commands & (2 << (bit * 2))) !== 0) {
        this.mask |= 1 << bit;
      }
    }
  }

  writeMode(commands: number): void {
    this.mode = (this.mode & ~127) | (commands & 127);
    for (const [clear, set, flag] of [
      [0x80, 0x100, 0x80],
      [0x200, 0x400, 0x100],
      [0x1000, 0x2000, 0x200],
    ]) {
      if ((commands & clear!) !== 0) {
        this.mode &= ~flag!;
      }
      if ((commands & set!) !== 0) {
        this.mode |= flag!;
      }
    }
    if ((commands & 0x800) !== 0) {
      this.pending &= ~32;
    }
  }

  snapshot() {
    return { pending: this.pending, mask: this.mask, mode: this.mode };
  }
}
