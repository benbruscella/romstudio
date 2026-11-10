import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, RamBus } from '../../runtime/mos6502.js';
import { NesSystemBus, type NesLaunch } from './system.js';
const launch = (): NesLaunch => ({
  version: 1,
  system: 'nes',
  timing: 'pal-2a07',
  ramFill: 0,
  cartridge: {
    mapper: 0,
    mirroring: 'vertical',
    prg: new Uint8Array(32768),
    chr: new Uint8Array(8192),
  },
});
test('Ricoh arithmetic ignores D while the shared NMOS CPU retains decimal arithmetic', () => {
  const n = new Machine(new NesSystemBus(launch())),
    c = new Machine(new RamBus());
  for (const s of [n, c]) {
    s.a = 0x99;
    s.p = 0x28;
    s.adc(1);
  }
  assert.equal(n.a, 0x9a);
  assert.equal(c.a, 0);
  assert.ok(n.p & 8);
  assert.equal(n.p & 1, 0);
  assert.equal(c.p & 1, 1);
});
test('RAM mirrors, serial pads, OAM DMA and NMI entry retain their hardware contracts', () => {
  const data = launch(),
    prg = Uint8Array.from(data.cartridge.prg);
  prg[0x7ffa] = 0x34;
  prg[0x7ffb] = 0x92;
  data.cartridge.prg = prg;
  const b = new NesSystemBus(data),
    s = new Machine(b);
  s.pc = 0x8000;
  b.write(0x0802, 42);
  assert.equal(b.read(2), 42);
  b.pad1 = 0x89;
  b.write(0x4016, 1);
  b.write(0x4016, 0);
  assert.deepEqual(
    Array.from({ length: 10 }, () => b.read(0x4016) & 1),
    [1, 0, 0, 1, 0, 0, 0, 1, 1, 1],
  );
  for (let i = 0; i < 256; i++) {
    b.ram[0x200 + i] = i;
  }
  b.write(0x4014, 2);
  assert.deepEqual(
    b.ppu.oam,
    Uint8Array.from({ length: 256 }, (_, i) => i),
  );
  assert.ok(b.boundary(s));
  assert.equal(s.cycles, 513);
  b.ppu.nmiPending = true;
  assert.ok(b.boundary(s));
  assert.equal(s.pc, 0x9234);
  assert.equal(s.cycles, 520);
  assert.equal(b.ram[0x1fd], 0x80);
  assert.equal(b.ram[0x1fc], 0);
});

test('PAL DMC waits for SYNC, fetches mapped PRG and does not repeat controller reads', () => {
  const data = launch(),
    prg = Uint8Array.from(data.cartridge.prg);
  prg[0x4000] = 0x5a;
  data.cartridge.prg = prg;
  const bus = new NesSystemBus(data),
    machine = new Machine(bus);
  bus.write(0x4010, 0x80);
  bus.write(0x4015, 0x10);
  assert.equal(bus.cpuCycle(1, false, true), 0, 'initial request is not ready');
  assert.equal(bus.cpuCycle(3, false, false), 0, 'operand reads do not halt PAL CPU');
  bus.pad1 = 1;
  bus.write(0x4016, 1);
  bus.write(0x4016, 0);
  assert.equal(bus.read(0x4016) & 1, 1);
  assert.equal(bus.index1, 1);
  machine.pc = 0x8000;
  machine.cycles = 4;
  machine.beginInstruction();
  machine.finishInstruction(2);
  assert.equal(machine.cycles, 9);
  assert.equal(bus.apu.dmc.buffer, 0x5a);
  assert.equal(bus.apu.dmc.reads, 1);
  assert.equal(bus.dmcStallCycles, 3);
  assert.equal(bus.apu.dmc.irq, true);
  assert.equal(bus.index1, 1);
});

test('APU IRQ is level-sensitive, obeys I, and yields priority to vblank NMI', () => {
  const data = launch(),
    prg = Uint8Array.from(data.cartridge.prg);
  prg.set([0x34, 0x92], 0x7ffa);
  prg.set([0x78, 0x96], 0x7ffe);
  data.cartridge.prg = prg;
  const bus = new NesSystemBus(data),
    machine = new Machine(bus);
  machine.pc = 0x8000;
  bus.apu.frame.irq = true;
  assert.equal(bus.boundary(machine), false);
  machine.flag(4, false);
  bus.ppu.nmiPending = true;
  assert.equal(bus.boundary(machine), true);
  assert.equal(machine.pc, 0x9234);
  assert.equal(bus.nmiEntries, 1);
  assert.equal(bus.irqEntries, 0);
  assert.equal(bus.apu.irq, true);
  assert.equal(bus.boundary(machine), false);
  machine.flag(4, false);
  assert.equal(bus.boundary(machine), true);
  assert.equal(machine.pc, 0x9678);
  assert.equal(bus.irqEntries, 1);
  assert.equal(bus.ram[0x1f8]! & 16, 0, 'interrupt pushes B clear');
  bus.read(0x4015);
  assert.equal(bus.apu.irq, false);
});

test('APU status takes only bit five from open bus and leaves the external data latch intact', () => {
  const bus = new NesSystemBus(launch());
  bus.openBus = 0xe5;
  bus.apu.frame.irq = true;
  assert.equal(bus.read(0x4015), 0x60);
  assert.equal(bus.read(0x4015), 0x20);
  assert.equal(bus.openBus, 0xe5);
});
