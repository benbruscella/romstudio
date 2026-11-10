import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vr4300Machine, Vr4300Ram, Vr4300Exception } from './vr4300.js';
import { N64System } from '../systems/n64/system.js';

function fixture() {
  const ram = new Vr4300Ram(),
    cpu = new Vr4300Machine(ram, 0x80001000, true);
  cpu.guestExceptions = true;
  return { ram, cpu };
}
function mapping(cpu: Vr4300Machine, pageMask = 0, global = true) {
  const cp0 = cpu.control;
  cp0.write(0, 0);
  cp0.write(5, pageMask);
  cp0.write(10, 0x04000012);
  cp0.write(2, (0x390 << 6) | 6 | Number(global));
  cp0.write(3, (0x3a0 << 6) | 6 | Number(global));
  cp0.writeTlb();
}

test('CPU mapped reads reach RDRAM while physical RSP/DMA addresses retain their own domain', () => {
  const system = new N64System(new Uint8Array(0), 0x80000000);
  mapping(system.cpu, 0x1e000);
  system.memory.ram.write32(0x390650, 0xd1d4);
  system.memory.signal.view.setUint32(0x650, 0x12345678, false);
  assert.equal(system.cpu.bus.read32(0x04000650), 0xd1d4);
  assert.equal(system.memory.read32(0x04000650), 0x12345678);
  system.cpu.bus.write32(0x04010650, 0x89abcdef);
  assert.equal(system.memory.ram.read32(0x3a0650), 0x89abcdef);
  assert.equal(system.memory.read32(0x04000650), 0x12345678);
  assert.equal(system.cpu.bus.read32(0x80390650), 0xd1d4);
  assert.equal(system.cpu.bus.read32(0xa0390650), 0xd1d4);
});

test('paired TLB pages select even/odd frames, mask PFN offset bits and distinguish ASIDs', () => {
  const { ram, cpu } = fixture();
  mapping(cpu, 0, false);
  ram.write8(0x390123, 0x51);
  ram.write8(0x3a0123, 0xa2);
  assert.equal(cpu.bus.read8(0x04000123), 0x51);
  assert.equal(cpu.bus.read8(0x04001123), 0xa2);
  cpu.control.write(10, 0x13);
  assert.throws(() => cpu.bus.read8(0x04000123), Vr4300Exception);
  assert.equal(cpu.pc, 0x80000000);
  assert.equal(cpu.control.read(8), 0x04000123);
  assert.equal(cpu.control.read(10), 0x04000013);
  assert.equal(cpu.control.read(4), 0x20000);
  const other = fixture();
  mapping(other.cpu, 0x1e000);
  other.cpu.control.tlb[0]!.entryLo0 = (0x39f << 6) | 7;
  other.ram.write16(0x39fffe, 0xbeef);
  other.cpu.control.write(10, 0x44); // Global pairs ignore ASID.
  assert.equal(other.cpu.bus.read16(0x0400fffe), 0xbeef);
});

test('TLB invalid, modification and nested misses enter guest exceptions before mutating memory', () => {
  for (const kind of ['invalid', 'modification', 'miss'] as const) {
    const { ram, cpu } = fixture();
    mapping(cpu);
    cpu.control.write(12, kind === 'miss' ? 2 : 0);
    if (kind === 'invalid') {
      cpu.control.tlb[0]!.entryLo0 &= ~2;
    }
    if (kind === 'modification') {
      cpu.control.tlb[0]!.entryLo0 &= ~4;
    }
    if (kind === 'miss') {
      cpu.control.tlb[0] = undefined;
    }
    ram.write32(0x390000, 0x12345678);
    assert.throws(() => cpu.bus.write32(0x04000000, 0), Vr4300Exception);
    assert.equal(ram.read32(0x390000), 0x12345678);
    assert.equal(cpu.pc, 0x80000180);
    assert.equal((cpu.control.read(13) >>> 2) & 31, kind === 'modification' ? 1 : 3);
    assert.equal(cpu.control.read(14), kind === 'miss' ? 0 : 0x80001000);
  }
});

test('TLB faults retain branch EPC/BD, privilege checks precede lookup, and ERL bypasses low mappings', () => {
  const { ram, cpu } = fixture();
  ram.write32(0x1000, 0x10000001);
  cpu.begin(0x80001000, 0x10000001);
  cpu.branch(true, 0x04000000);
  cpu.finish();
  assert.throws(() => cpu.bus.read32(0x04000000), Vr4300Exception);
  assert.equal(cpu.control.read(14), 0x80001000);
  assert.equal(cpu.control.read(13) >>> 31, 1);
  assert.equal(cpu.pc, 0x80000000);
  const other = fixture();
  other.cpu.control.write(12, 0x10); // User mode cannot read kernel segments.
  assert.throws(() => other.cpu.bus.read32(0x80001000), Vr4300Exception);
  assert.equal((other.cpu.control.read(13) >>> 2) & 31, 4);
  other.cpu.control.write(12, 4);
  other.ram.write32(0x1000, 0xfeedface);
  assert.equal(other.cpu.bus.read32(0x1000), 0xfeedface);
  assert.throws(() => other.cpu.bus.write32(0x1001, 0), Vr4300Exception);
  assert.equal((other.cpu.control.read(13) >>> 2) & 31, 5);
  const system = new N64System(new Uint8Array(0), 0x80000000);
  system.memory.ram.write32(0, 0x1000ffff);
  system.cpu.control.write(12, 0x10);
  assert.equal(system.advanceIdle(), 0); // Optimization must not raise speculative faults.
  system.step((machine) => {
    machine.bus.read32(machine.pc);
  });
  assert.equal(system.synchronousExceptions, 1);
  assert.equal(system.cpu.pc, 0x80000180);
  assert.equal(system.cpu.control.read(14), 0x80000000);
});
