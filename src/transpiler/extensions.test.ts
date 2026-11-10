import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './mos6502.js';
import { lift } from './lift.js';
import { Machine, RamBus } from '../runtime/mos6502.js';
import { recover } from './recover.js';
async function compiled(javascript: string): Promise<{ step: (machine: Machine) => void }> {
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as { step: (machine: Machine) => void };
}

test('reviewed NMOS NOPs require opt-in, preserve registers/flags and perform indexed reads including page crossing', async () => {
  for (const opcode of [0x3c, 0xfc]) {
    for (const base of [0x2000, 0x20ff, 0xffff]) {
      const bus = new RamBus();
      bus.bytes.set([opcode, base & 255, base >>> 8], 0x8000);
      assert.throws(() => decode(bus.bytes, 0x8000), /Unsupported NMOS opcode/);
      const instruction = decode(bus.bytes, 0x8000, { undocumentedOpcodes: [opcode] });
      const { step } = await compiled(lift([instruction]).javascript),
        s = new Machine(bus);
      s.pc = 0x8000;
      s.a = 0x42;
      s.x = 2;
      s.y = 7;
      s.p = 0x65;
      s.sp = 0xfa;
      const reads: number[] = [],
        read = bus.read.bind(bus);
      bus.read = (address) => {
        reads.push(address);
        return read(address);
      };
      step(s);
      const target = (base + 2) & 65535,
        crosses = (base & 0xff00) !== (target & 0xff00);
      assert.deepEqual(reads, crosses ? [(base & 0xff00) | (target & 255), target] : [target]);
      assert.deepEqual(s.snapshot(), {
        a: 0x42,
        x: 2,
        y: 7,
        p: 0x65,
        sp: 0xfa,
        pc: 0x8003,
        cycles: crosses ? 5 : 4,
        instructions: 1,
      });
    }
  }
});

test('recovery enables only declared, implemented NMOS extensions', () => {
  const bus = new RamBus();
  bus.bytes.set([0x3c, 0, 0x20], 0x8000);
  const run = (enabled: boolean) => {
    const s = new Machine(bus);
    s.pc = 0x8000;
    return recover(s, {
      stopAt: 0x8003,
      maxInstructions: 2,
      maxVariants: 2,
      ...(enabled ? { undocumentedOpcodes: [0x3c] } : {}),
    });
  };
  assert.equal(run(false).gap?.kind, 'opcode');
  assert.equal(run(true).stop, 'checkpoint');
  assert.throws(
    () =>
      recover(new Machine(bus), {
        stopAt: 1,
        maxInstructions: 2,
        maxVariants: 2,
        undocumentedOpcodes: [2],
      }),
    /unimplemented NMOS/,
  );
});
