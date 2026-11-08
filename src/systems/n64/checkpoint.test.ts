import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64System } from './system.js';
import { clearN64Trace, compactN64Checkpoint } from './checkpoint.js';
import { decodeVr4300, compileVr4300 } from '../../transpiler/vr4300.js';

test('discarding N64 traces preserves pending DMA, PCM and original clock execution', () => {
  const cartridge = Uint8Array.from({ length: 128 }, (_, i) => i),
    outputs: number[][] = [[], []];
  const make = (index: number) => {
    const system = new N64System(cartridge, 0x80000000, 512),
      m = system.memory;
    m.ram.write32(0, 0x1000ffff);
    m.ram.write32(4, 0);
    m.ram.write32(0x1000, 0x7fff8000);
    m.ram.write32(0x1004, 0x1234fedc);
    m.peripheral.write(0, 0x800);
    m.peripheral.write(4, 0x10000000);
    m.peripheral.write(12, 127);
    m.signal.write(0, 0x100);
    m.signal.write(4, 0x800);
    m.signal.write(8, 127);
    m.audio.write(0, 0x1000);
    m.audio.write(8, 1);
    m.audio.write(16, 31);
    m.audio.write(4, 8);
    m.audio.output = (left, right) => outputs[index]!.push(left, right);
    return system;
  };
  const original = make(0),
    bounded = make(1);
  const operations = new Map(
    [0x80000000, 0x80000004].map((pc) => [
      pc,
      compileVr4300(decodeVr4300(original.cpu.bus.read32(pc), pc)),
    ]),
  );
  const step = (s: typeof original.cpu) => operations.get(s.pc)!(s);
  for (let tick = 0; tick < 2000; tick++) {
    original.step(step);
    bounded.step(step);
    if (tick % 17 === 0) {
      clearN64Trace(bounded);
    }
  }
  assert.deepEqual(compactN64Checkpoint(original), compactN64Checkpoint(bounded));
  assert.deepEqual(original.memory.ram.bytes, bounded.memory.ram.bytes);
  assert.deepEqual(original.memory.signal.memory, bounded.memory.signal.memory);
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(outputs[0]!.length, 4);
  assert.equal(original.memory.ram.bytes[0x87f], 127);
});
