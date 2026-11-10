import { ExecutionGap, Machine } from '../../runtime/mos6502.js';
import type { AddressSpace } from '../../memory.js';
import { C64RecoveryBus } from '../c64.js';
import { Cia6526 } from './cia.js';
import { VicII } from './vic.js';
import { KernalServices, vicStartupRegisters } from './kernal.js';
export class C64SystemBus extends C64RecoveryBus {
  cpuCycle: ((cycle: number, write: boolean) => number) | undefined;
  readonly vic = new VicII();
  readonly cia1 = new Cia6526(0xdc00);
  readonly cia2 = new Cia6526(0xdd00);
  readonly colour = new Uint8Array(1024);
  readonly sid = new Uint8Array(32);
  sidWriteCount = 0;
  sidBusValue = 0;
  sidWriteObserver: ((register: number, value: number, cycle: number) => void) | undefined;
  readonly kernal = new KernalServices();
  clock = 0;
  irqEntries = 0;
  defaultIrqCalls = 0;
  constructor(space: AddressSpace) {
    super(space);
    this.seed(0x288, 4); // Explicit post-BASIC screen-page launch precondition.
    this.seed(0x2a6, 1); // PAL launch recipe.
    for (const address of [0xa0, 0xa1, 0xa2]) {
      this.seed(address, 0);
    } // Explicit jiffy-clock epoch.
  }
  seed(address: number, value: number): void {
    if (!this.known[address]) {
      this.bytes[address] = value;
      this.known[address] = 1;
    }
  }
  isIo(address: number): boolean {
    return (
      address >= 0xd000 && address < 0xe000 && !!(this.bytes[1]! & 3) && !!(this.bytes[1]! & 4)
    );
  }
  override read(address: number): number {
    if (this.bytes[1]! & 2) {
      if (address >= 0xecb9 && address <= 0xece7) {
        return vicStartupRegisters()[address - 0xecb9]!;
      }
      if (address >= 0xecf0 && address < 0xed09) {
        return ((address - 0xecf0) * 40) & 255;
      }
    }
    if (!this.isIo(address)) {
      return super.read(address);
    }
    if (address < 0xd400) {
      return this.vic.read(address & 63);
    }
    if (address < 0xd800) {
      const r = address & 31;
      if (r === 0x19 || r === 0x1a) {
        return 255;
      } // Open paddle inputs: joystick-only launch profile.
      if (r === 0x1b || r === 0x1c) {
        throw new ExecutionGap(
          'sid-read',
          address,
          'SID oscillator and envelope reads are not implemented.',
        );
      }
      return this.sidBusValue; // Write-only register bus latch; analogue decay is not modelled.
    }
    if (address < 0xdc00) {
      return this.colour[address & 1023]! | 0xf0;
    }
    if (address < 0xdd00) {
      return this.cia1.read(address & 15);
    }
    if (address < 0xde00) {
      return this.cia2.read(address & 15);
    }
    throw new ExecutionGap('expansion-io', address, 'Expansion I/O is not implemented.');
  }
  override write(address: number, value: number): void {
    value &= 255;
    if (!this.isIo(address)) {
      super.write(address, value);
      return;
    }
    this.ioWrites.push({ address, value, pc: this.writerPc });
    if (this.ioWrites.length > 64) {
      this.ioWrites.shift();
    }
    if (address < 0xd400) {
      this.vic.write(address & 63, value);
      return;
    }
    if (address < 0xd800) {
      this.sidWriteObserver?.(address & 31, value, this.clock);
      this.sid[address & 31] = value;
      this.sidBusValue = value;
      this.sidWriteCount++;
      return;
    }
    if (address < 0xdc00) {
      this.colour[address & 1023] = value & 15;
      return;
    }
    if (address < 0xdd00) {
      this.cia1.write(address & 15, value);
      return;
    }
    if (address < 0xde00) {
      this.cia2.write(address & 15, value);
      return;
    }
    throw new ExecutionGap('expansion-io', address, 'Expansion I/O is not implemented.');
  }
  advanceTo(cycles: number): void {
    const elapsed = cycles - this.clock;
    if (elapsed < 0) {
      throw new Error('C64 clock cannot run backwards.');
    }
    this.vic.advance(elapsed);
    this.cia1.advance(elapsed);
    this.cia2.advance(elapsed);
    this.clock = cycles;
  }
  boundary(s: Machine): boolean {
    this.advanceTo(s.cycles);
    if (s.pc === 0xea31 && this.bytes[1]! & 2) {
      // Functional clock/keyboard IRQ contract. Character input is a recorded
      // host queue; cursor animation and scan-loop cycle parity remain unverified.
      const ticks = (s.read(0xa0) << 16) | (s.read(0xa1) << 8) | s.read(0xa2);
      const next = (ticks + 1) % 5184000;
      s.write(0xa0, next >>> 16);
      s.write(0xa1, (next >>> 8) & 255);
      s.write(0xa2, next & 255);
      if (this.cia1.space || this.cia1.pressedKeys.size) {
        throw new ExecutionGap(
          'keyboard-scan',
          s.pc,
          'Default IRQ matrix scanning with held keys is not implemented.',
        );
      }
      // No-key path through EA87/EB42. Restore column 7 after scanning so a
      // preceding paddle probe cannot leave joystick lines driven low.
      s.write(0x28d, 0);
      s.write(0xcb, 0x40);
      s.write(0xc5, 0x40);
      s.write(0x28e, 0);
      s.write(0xdc00, 0x7f);
      s.read(0xdc0d);
      s.pc = 0xea81;
      s.cycles += 80;
      this.defaultIrqCalls++;
      return true;
    }
    if (s.pc === 0xea81 && this.bytes[1]! & 2) {
      s.y = s.nz(s.pop());
      s.x = s.nz(s.pop());
      s.a = s.nz(s.pop());
      s.p = (s.pop() | 32) & 239;
      s.pc = s.pop() | (s.pop() << 8);
      s.cycles += 22;
      s.instructions += 6;
      return true;
    }
    if (this.bytes[1]! & 2 && this.kernal.dispatch(s)) {
      return true;
    }
    if (this.cia2.irq) {
      throw new ExecutionGap('nmi', s.pc, 'CIA2 NMI delivery is not implemented.');
    }
    if (!(s.p & 4) && (this.vic.irq || this.cia1.irq)) {
      s.push(s.pc >>> 8);
      s.push(s.pc & 255);
      s.push(s.p & 239);
      s.flag(4, true);
      s.cycles += 7;
      if (this.bytes[1]! & 2) {
        // Stock KERNAL IRQ entry ($FF48): save A/X/Y, inspect BRK and dispatch
        // through the writable IRQ vector. This also supports nested raster IRQs.
        s.push(s.a);
        s.a = s.nz(s.x);
        s.push(s.a);
        s.a = s.nz(s.y);
        s.push(s.a);
        s.x = s.nz(s.sp);
        s.a = s.nz(s.read(0x100 + s.x + 4));
        s.a = s.nz(s.a & 16);
        s.pc = s.word(s.a ? 0x316 : 0x314);
        s.cycles += s.a ? 28 : 29;
        s.instructions += 10;
      } else {
        s.pc = s.word(0xfffe);
      }
      this.irqEntries++;
      return true;
    }
    return false;
  }
}
