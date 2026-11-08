import { ExecutionGap } from '../../runtime/mos6502.js';
class Timer {
  latch = 0xffff;
  counter = 0xffff;
  control = 0;
  advance(cycles: number): number {
    if (!(this.control & 1)) {
      return 0;
    }
    if (cycles <= this.counter) {
      this.counter -= cycles;
      return 0;
    }
    const remaining = cycles - this.counter - 1;
    if (this.control & 8) {
      this.control &= ~1;
      this.counter = this.latch;
      return 1;
    }
    const underflows = 1 + Math.floor(remaining / (this.latch + 1));
    this.counter = this.latch - (remaining % (this.latch + 1));
    return underflows;
  }
}
/** Ports, interrupt latches and PHI2 timers needed during startup. External CNT,
 * serial transfer and TOD reads remain explicit gaps. */
export class Cia6526 {
  readonly registers = new Uint8Array(16);
  readonly a = new Timer();
  readonly b = new Timer();
  pending = 0;
  mask = 0;
  inputA = 255;
  inputB = 255;
  space = false;
  /** Each switch connects one PA column pin to one PB row pin. */
  readonly pressedKeys = new Set<number>();
  setKey(column: number, row: number, pressed: boolean): void {
    if (
      this.base !== 0xdc00 ||
      !Number.isInteger(column) ||
      column < 0 ||
      column > 7 ||
      !Number.isInteger(row) ||
      row < 0 ||
      row > 7
    ) {
      throw new Error('C64 keyboard switches need CIA1 column/row indices 0–7.');
    }
    const key = column * 8 + row;
    if (pressed) {
      this.pressedKeys.add(key);
    } else {
      this.pressedKeys.delete(key);
    }
  }
  constructor(readonly base: number) {
    this.registers[0] = base === 0xdc00 ? 0x7f : 3;
    this.registers[1] = 255;
    this.registers[2] = base === 0xdc00 ? 255 : 3;
  }
  get irq(): boolean {
    return !!(this.pending & this.mask & 31);
  }
  advance(cycles: number): void {
    if (this.a.control & 0x20 && this.a.control & 1) {
      throw new ExecutionGap('cia-cnt', this.base + 14, 'External CNT timer clock is unsupported.');
    }
    const underflows = this.a.advance(cycles);
    if (underflows) {
      this.pending |= 1;
    }
    const mode = this.b.control & 0x60;
    if (this.b.control & 1 && mode !== 0 && mode !== 0x40) {
      throw new ExecutionGap('cia-cnt', this.base + 15, 'External CNT timer clock is unsupported.');
    }
    if (this.b.advance(mode === 0x40 ? underflows : cycles)) {
      this.pending |= 2;
    }
  }
  read(register: number): number {
    const r = register & 15;
    if (r < 2) {
      let portA =
        ((this.registers[0]! & this.registers[2]!) | (~this.registers[2]! & 255)) & this.inputA;
      let portB =
        ((this.registers[1]! & this.registers[3]!) | (~this.registers[3]! & 255)) & this.inputB;
      if (this.base === 0xdc00 && (this.space || this.pressedKeys.size)) {
        const switches = [...this.pressedKeys, ...(this.space ? [7 * 8 + 4] : [])];
        // Propagate low pins across closed switches, including reverse scans
        // and connected multi-key paths. This is a digital closure model.
        for (let pass = 0; pass < 16; pass++) {
          const beforeA = portA,
            beforeB = portB;
          for (const key of switches) {
            const a = 1 << (key >>> 3),
              b = 1 << (key & 7);
            if (!(portA & a)) {
              portB &= ~b;
            }
            if (!(portB & b)) {
              portA &= ~a;
            }
          }
          if (portA === beforeA && portB === beforeB) {
            break;
          }
        }
      }
      // Reads observe the actual pins, including a joystick switch pulling an
      // output-configured line low, rather than merely reading the output latch.
      return r === 0 ? portA : portB;
    }
    if (r === 4 || r === 5) {
      return r === 4 ? this.a.counter & 255 : this.a.counter >>> 8;
    }
    if (r === 6 || r === 7) {
      return r === 6 ? this.b.counter & 255 : this.b.counter >>> 8;
    }
    if (r === 13) {
      const value = this.pending | (this.irq ? 128 : 0);
      this.pending = 0;
      return value;
    }
    if (r === 14) {
      return this.a.control;
    }
    if (r === 15) {
      return this.b.control;
    }
    if (r >= 8 && r <= 12) {
      throw new ExecutionGap(
        'cia-feature',
        this.base + r,
        'CIA TOD and serial reads are not implemented.',
      );
    }
    return this.registers[r]!;
  }
  write(register: number, value: number): void {
    const r = register & 15;
    value &= 255;
    if (r >= 4 && r <= 7) {
      const timer = r < 6 ? this.a : this.b;
      timer.latch = r & 1 ? (timer.latch & 255) | (value << 8) : (timer.latch & 0xff00) | value;
      if (r & 1 && !(timer.control & 1)) {
        timer.counter = timer.latch;
      }
    } else if (r === 13) {
      this.mask = value & 128 ? this.mask | (value & 31) : this.mask & ~(value & 31);
    } else if (r >= 14) {
      const timer = r === 14 ? this.a : this.b;
      if (value & 16) {
        timer.counter = timer.latch;
      }
      timer.control = value & ~16;
    }
    this.registers[r] = value;
  }
}
