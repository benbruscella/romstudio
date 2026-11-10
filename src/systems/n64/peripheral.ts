import { Vr4300Gap } from '../../runtime/vr4300.js';

/** Cartridge-to-RDRAM PI transfers. Completion is scheduled, so busy state and
 * acknowledgement are observable. The initial clock is a functional work
 * model (one halfword per tick), not measured cartridge latency. */
export class N64Peripheral {
  readonly registers = new Uint32Array(13);
  private active: { ram: number; cartridge: number; length: number; remaining: number } | undefined;
  readonly transfers: { ram: number; cartridge: number; length: number }[] = [];

  constructor(
    private readonly ram: Uint8Array,
    private readonly cartridge: Uint8Array,
    private readonly interrupt: (asserted: boolean) => void,
  ) {}

  read(offset: number): number {
    return offset === 0x10 ? Number(!!this.active) : this.registers[offset >>> 2]!;
  }

  write(offset: number, value: number): void {
    const word = value >>> 0;
    if (offset === 0x10) {
      if ((word & 1) !== 0 && this.active) {
        this.active = undefined;
        this.interrupt(true);
      }
      if ((word & 2) !== 0) {
        this.interrupt(false);
      }
      return;
    }
    if (this.active && offset <= 0x0c) {
      throw new Vr4300Gap('pi-busy', 0, 0x04600000 + offset, 'PI transfer registers are busy.');
    }
    if (offset === 0x08) {
      throw new Vr4300Gap(
        'pi-write',
        0,
        0x04600008,
        'Cartridge save-memory DMA is not implemented.',
      );
    }
    const mask =
      offset === 0
        ? 0xfffffe
        : offset === 4
          ? 0xfffffffe
          : offset === 0x0c
            ? 0xffffff
            : [0x1c, 0x2c].includes(offset)
              ? 15
              : [0x20, 0x30].includes(offset)
                ? 3
                : 255;
    this.registers[offset >>> 2] = word & mask;
    if (offset !== 0x0c) {
      return;
    }
    const ram = this.registers[0]!,
      cartridge = this.registers[1]!,
      length = (word & 0xffffff) + 1;
    if (ram % 8 !== 0 || length % 2 !== 0) {
      throw new Vr4300Gap(
        'pi-alignment',
        0,
        ram,
        'Unaligned PI transfer behavior is not implemented.',
      );
    }
    if (
      ram + length > this.ram.length ||
      cartridge < 0x10000000 ||
      cartridge - 0x10000000 + length > this.cartridge.length
    ) {
      throw new Vr4300Gap(
        'pi-range',
        0,
        cartridge,
        'PI transfer exceeds the installed ROM or RDRAM.',
      );
    }
    this.active = { ram, cartridge, length, remaining: 8 + length / 2 };
  }

  advance(ticks: number): void {
    const active = this.active;
    if (!active) {
      return;
    }
    active.remaining -= ticks;
    if (active.remaining > 0) {
      return;
    }

    this.ram.set(
      this.cartridge.subarray(
        active.cartridge - 0x10000000,
        active.cartridge - 0x10000000 + active.length,
      ),
      active.ram,
    );
    this.registers[0] = active.ram + active.length;
    this.registers[1] = active.cartridge + active.length;
    this.transfers.push({ ram: active.ram, cartridge: active.cartridge, length: active.length });
    this.active = undefined;
    this.interrupt(true);
  }
  ticksUntilEvent(): number {
    return this.active?.remaining ?? Infinity;
  }

  snapshot() {
    return {
      registers: [...this.registers],
      active: this.active ? { ...this.active } : null,
      transfers: this.transfers.map((transfer) => ({ ...transfer })),
    };
  }
  restore(state: ReturnType<N64Peripheral['snapshot']>): void {
    this.registers.set(state.registers);
    this.active = state.active ? { ...state.active } : undefined;
    this.transfers.length = 0;
    for (const transfer of state.transfers) {
      this.transfers.push({ ...transfer });
    }
  }
}
