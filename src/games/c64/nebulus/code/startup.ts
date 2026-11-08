import { ExecutionGap, type Machine } from '../../../../runtime/mos6502.js';
import type { C64SystemBus } from '../../../../systems/c64/system.js';
import { loadDiskPrg, type C64DiskFile } from '../../../../systems/c64/disk.js';

/** Reviewed startup boundaries for the supplied NFI Tower Toppler release.
 * Names are ROM Studio's; source addresses identify the original instructions. */
export class NebulusStartup {
  relocationCount = 0;
  screenClears = 0;
  readonly inputs: { kind: string; caller: number; value: number }[] = [];
  readonly diskReads: ReturnType<typeof loadDiskPrg>[] = [];
  constructor(
    readonly bus: C64SystemBus,
    readonly files: Pick<ReadonlyMap<string, C64DiskFile>, 'get'> = new Map(),
  ) {}

  /** $690C copies six pages, XORing with $08. The final page includes unknown
   * padding, so retain its knownness instead of claiming recovered zeroes.
   * Include JMP $CAD9 / LDA #$00: that LDA kills the unknown final A value. */
  relocateTrainer(s: Machine): void {
    s.guard(
      0x690c,
      [
        0xa2, 6, 0xa0, 0, 0xb9, 0x27, 0x69, 0x49, 8, 0x99, 0, 0xc9, 0xc8, 0xd0, 0xf5, 0xee, 0x12,
        0x69, 0xee, 0x17, 0x69, 0xca, 0xd0, 0xec, 0x4c, 0xd9, 0xca,
      ],
    );
    if (
      s.read(1) !== 0x37 ||
      s.p & 8 ||
      this.bus.vic.irqMask ||
      this.bus.cia1.mask ||
      this.bus.cia2.mask
    ) {
      throw new ExecutionGap(
        'title-annotation',
        s.pc,
        'Trainer relocation needs the reviewed banking, binary mode and inactive IRQ sources.',
      );
    }
    for (let page = 0; page < 6; page++) {
      for (let y = 0; y < 256; y++) {
        const source = 0x6927 + page * 256 + y,
          destination = 0xc900 + page * 256 + y;
        this.bus.writerPc = 0x6915;
        s.write(destination, this.bus.bytes[source]! ^ 8);
        this.bus.known[destination] = this.bus.known[source]!;
      }
      for (const [pc, address] of [
        [0x691b, 0x6912],
        [0x691e, 0x6917],
      ]) {
        this.bus.writerPc = pc!;
        const old = s.read(address!);
        s.write(address!, old);
        s.write(address!, old + 1);
      }
    }
    s.guard(0xcad9, [0xa9, 0]);
    s.x = 0;
    s.y = 0;
    s.a = s.nz(0);
    s.pc = 0xcadb;
    s.instructions += 7708;
    s.cycles += 24914;
    this.relocationCount++;
  }

  boundary(s: Machine): boolean {
    const kernalMapped = !!(this.bus.bytes[1]! & 2);
    if (kernalMapped && s.pc === 0xffd5) {
      this.diskReads.push(loadDiskPrg(s, this.files));
      return true;
    }
    if (s.pc === 0x690c && this.relocationCount === 0) {
      this.relocateTrainer(s);
      return true;
    }
    if (kernalMapped && s.pc === 0xffd2 && s.a === 0x93) {
      s.guard(0xcae8, [0x20, 0xd2, 0xff]);
      // This observed CHROUT control enters the existing screen-clear service.
      // Its wrapper overhead and IRQ preemption are not cycle-accurate.
      this.bus.kernal.clearScreen(s);
      this.screenClears++;
      return true;
    }
    if (kernalMapped && s.pc === 0xffe4) {
      const caller =
        ((s.read(0x100 | ((s.sp + 1) & 255)) | (s.read(0x100 | ((s.sp + 2) & 255)) << 8)) + 1) &
        65535;
      let value = 0;
      if (caller === 0xcde3 && !this.inputs.some((input) => input.kind === 'intro-space')) {
        s.guard(0xcde0, [0x20, 0xe4, 0xff, 0xc9, 0x20, 0xd0, 0xf9]);
        value = 32;
        this.inputs.push({ kind: 'intro-space', caller, value });
      }
      this.bus.kernal.characterInput = () => value;
    }
    if (s.pc === 0x6822 && !this.inputs.some((input) => input.kind === 'picture-fire')) {
      s.guard(0x6822, [0x20, 0x55, 0x68, 0x29, 0x1f, 0xc9, 0x1f]);
      this.bus.cia1.inputA = 239;
      this.inputs.push({ kind: 'picture-fire', caller: s.pc, value: 239 });
    }
    if (s.pc === 0x683c) {
      this.bus.cia1.inputA = 255;
    }
    return this.bus.boundary(s);
  }
}
