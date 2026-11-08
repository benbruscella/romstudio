import { type SystemAdapter } from '../contracts.js';
import { ExecutionGap, RamBus } from '../runtime/mos6502.js';
import type { AddressSpace } from '../memory.js';
import type { Instruction } from '../transpiler/mos6502.js';

export const c64: SystemAdapter = {
  id: 'c64',
  version: '3',
  cpu: 'mos6510-nmos',
  formats: ['d64'],
  timing: { id: 'pal-6569', cyclesPerLine: 63, linesPerFrame: 312, clockHz: 985248 },
  web: {
    id: 'c64-pal',
    width: 320,
    height: 200,
    aspectRatio: '4 / 3',
    joystickPorts: [1, 2],
    defaultJoystickPort: 2,
    keyboard: {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Space: 'fire',
    },
    diskSwitching: true,
    serializable: false,
  },
  firmware: [
    'No ROM image is needed for the bootstrap or observed menu path. Other firmware entry points remain explicit gaps.',
  ],
  capabilities: [
    'd64-directory',
    'sector-chain',
    'prg-load',
    'basic-sys-entry',
    'nmos-disassembly',
    'instruction-lifting',
    'bootstrap-fixture',
    'startup-kernal-services',
    'pal-raster-registers',
    'cia-ports-and-timers',
    'keyboard-switches',
    'menu-snapshot',
  ],
};

/** A deliberately synthetic bus for a CPU/bootstrap fixture, NOT a C64 machine.
 * The only device reads used by the verified bootstrap are explicitly seeded.
 * Any further device access stops instead of silently inventing hardware behavior. */
export class BootstrapFixtureBus extends RamBus {
  readonly ioWrites: { address: number; value: number }[] = [];
  private readonly registers = new Map([
    [0xd030, 0xff],
    [0xd011, 0x1b],
  ]);
  constructor(bytes: Uint8Array) {
    super(bytes);
    this.bytes[1] = 0x37;
  }
  override read(address: number): number {
    if (address >= 0xd000 && address <= 0xdfff) {
      if (!this.registers.has(address)) {
        throw new ExecutionGap(
          'device',
          address,
          'No device model for this address in the bootstrap fixture.',
        );
      }
      return this.registers.get(address)!;
    }
    return super.read(address);
  }
  override write(address: number, value: number): void {
    if (address >= 0xd000 && address <= 0xdfff) {
      if (!this.registers.has(address)) {
        throw new ExecutionGap(
          'device',
          address,
          'No device model for this address in the bootstrap fixture.',
        );
      }
      this.ioWrites.push({ address, value });
      this.registers.set(address, value);
      return;
    }
    super.write(address, value);
  }
}

/** Bounded unpacker recovery: RAM banking and a small set of observed bootstrap
 * registers. No raster, interrupts, firmware or uninitialised RAM are fabricated. */
export class C64RecoveryBus extends RamBus {
  readonly known: Uint8Array;
  readonly executed = new Uint8Array(65536);
  readonly executedAfterWrite = new Uint8Array(65536);
  readonly lastWriter = new Int32Array(65536).fill(-1);
  readonly changedCode = new Map<
    number,
    { writes: number; firstWriter: number; lastWriter: number }
  >();
  readonly ioWrites: { address: number; value: number; pc: number }[] = [];
  readonly registers = new Map([
    [0xd011, 0x1b],
    [0xd020, 0],
    [0xd021, 0],
  ]);
  writerPc = -1;
  epoch = 0;
  constructor(space: AddressSpace) {
    super(space.bytes);
    this.known = space.loaded.slice();
    this.bytes[0] = 0x2f;
    this.bytes[1] = 0x37;
    this.known[0] = 1;
    this.known[1] = 1;
  }
  private ioMapped(address: number): boolean {
    return (
      address >= 0xd000 && address <= 0xdfff && !!(this.bytes[1]! & 3) && !!(this.bytes[1]! & 4)
    );
  }
  override read(address: number): number {
    if (address >= 0xe000 && this.bytes[1]! & 2) {
      throw new ExecutionGap(
        'firmware',
        address,
        'KERNAL read needs supplied firmware or a reviewed system service.',
      );
    }
    if (address >= 0xa000 && address <= 0xbfff && (this.bytes[1]! & 3) === 3) {
      throw new ExecutionGap('firmware', address, 'BASIC ROM read is not implemented.');
    }
    if (address >= 0xd000 && address <= 0xdfff && this.bytes[1]! & 3) {
      if (!(this.bytes[1]! & 4)) {
        throw new ExecutionGap('firmware', address, 'Character ROM read is not implemented.');
      }
      if (address === 0xd030) {
        return 255;
      }
      const value = this.registers.get(address);
      if (value === undefined) {
        throw new ExecutionGap('device', address, 'No device read model for this address.');
      }
      return value;
    }
    if (!this.known[address]) {
      throw new ExecutionGap(
        'unknown-memory',
        address,
        'RAM has not been loaded, written or explicitly seeded.',
      );
    }
    return super.read(address);
  }
  override write(address: number, value: number): void {
    if (this.ioMapped(address)) {
      if (address !== 0xd030 && !this.registers.has(address)) {
        throw new ExecutionGap('device', address, 'No device write model for this address.');
      }
      // Record aggregate effects, retaining a bounded tail for diagnostics.
      this.ioWrites.push({ address, value, pc: this.writerPc });
      if (this.ioWrites.length > 64) {
        this.ioWrites.shift();
      }
      if (address === 0xd011) {
        this.registers.set(address, value & 127);
      }
      if (address === 0xd020 || address === 0xd021) {
        this.registers.set(address, value & 15);
      }
      return;
    }
    if (address === 0 && value !== 0x2f) {
      throw new ExecutionGap(
        'processor-port',
        address,
        'Recovery currently requires the explicitly seeded $2F processor-port direction register.',
      );
    }
    if (this.executed[address] && this.bytes[address] !== value) {
      this.epoch++;
      const prior = this.changedCode.get(address);
      this.changedCode.set(address, {
        writes: (prior?.writes ?? 0) + 1,
        firstWriter: prior?.firstWriter ?? this.writerPc,
        lastWriter: this.writerPc,
      });
    }
    this.known[address] = 1;
    this.lastWriter[address] = this.writerPc;
    super.write(address, value);
  }
  override peek(address: number): number {
    if (this.ioMapped(address)) {
      throw new ExecutionGap(
        'device-execution',
        address,
        'Executing instructions from I/O is unsupported.',
      );
    }
    return this.read(address);
  }
  observe(instruction: Instruction): void {
    this.writerPc = instruction.address;
    for (let n = 0; n < instruction.size; n++) {
      const address = (instruction.address + n) & 65535;
      this.executed[address] = 1;
      if (this.lastWriter[address]! >= 0) {
        this.executedAfterWrite[address] = 1;
      }
    }
  }
}
