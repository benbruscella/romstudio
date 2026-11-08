import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPCODES, decode } from './mos6502.js';
import { lift } from './lift.js';
import { liftObservedShapes, liftAddressPages, programFiles } from './static.js';
import { Machine, RamBus } from '../runtime/mos6502.js';
import { importStaticProgram } from './program.js';

async function moduleFor(javascript: string): Promise<{ step: (machine: Machine) => void }> {
  return await importStaticProgram({ javascript });
}

test('guarded mutable operands agree with exact-byte lifting across all documented instruction shapes', async () => {
  const bytes = Uint8Array.from({ length: 65536 }, (_, index) => (index * 37 + 13) & 255);
  for (const opcode of OPCODES.keys()) {
    const source = bytes.slice();
    source.set([opcode, 0x20, 0x90], 0x8000);
    const shape = liftObservedShapes([decode(source, 0x8000)]);
    const mutable = await moduleFor(shape.javascript);
    for (const operand of [0x20, 0xfe]) {
      source[0x8001] = operand;
      const exact = await moduleFor(lift([decode(source, 0x8000)]).javascript);
      const a = new Machine(new RamBus(source)),
        b = new Machine(new RamBus(source));
      for (const s of [a, b]) {
        s.pc = 0x8000;
        s.a = 0x42;
        s.x = 2;
        s.y = 3;
        s.sp = 255;
        s.p = 0x20;
      }
      if (opcode === 0) {
        assert.throws(() => exact.step(a), /interrupt/);
        assert.throws(() => mutable.step(b), /interrupt/);
      } else {
        exact.step(a);
        mutable.step(b);
      }
      assert.deepEqual(b.snapshot(), a.snapshot(), `opcode ${opcode}, operand ${operand}`);
      assert.deepEqual((b.bus as RamBus).bytes, (a.bus as RamBus).bytes);
    }
    source[0x8000] = opcode ^ 255;
    const absent = new Machine(new RamBus(source));
    absent.pc = 0x8000;
    assert.throws(() => mutable.step(absent), /not recovered/);
  }
});

test('source-address pages retain cross-page control flow and guarded mutable operands', async () => {
  const bytes = new Uint8Array(65536);
  bytes.set([0xa9, 42, 0x8d, 0, 2, 0x4c, 0, 0x90], 0x8000);
  bytes.set([0xa2, 99], 0x9000);
  const generated = liftAddressPages(
    [0x8000, 0x8002, 0x8005, 0x9000].map((at) => decode(bytes, at)),
    { pageThreshold: 1 },
  );
  assert.deepEqual(Object.keys(generated.modules!), ['pages/8000', 'pages/9000']);
  assert.ok(programFiles(generated, true)['pages/9000.ts']!.includes('at_9000_a2'));
  const { step } = await importStaticProgram(generated);
  const machine = new Machine(new RamBus(bytes));
  machine.pc = 0x8000;
  for (let count = 0; count < 4; count++) {
    step(machine);
  }
  assert.equal(machine.a, 42);
  assert.equal(machine.x, 99);
  assert.equal(machine.bus.read(0x200), 42);
  machine.bus.write(0x9001, 55);
  machine.pc = 0x9000;
  step(machine);
  assert.equal(machine.x, 55);
  machine.bus.write(0x9000, 0xa0);
  machine.pc = 0x9000;
  assert.throws(() => step(machine), /not recovered/);
});

test('static dispatch selects only recovered address/opcode pairs, including alternate code at one address', async () => {
  const bytes = new Uint8Array(65536),
    shapes = [];
  for (const opcode of [0xa9, 0xa2]) {
    bytes.set([opcode, 42], 0x8000);
    shapes.push(decode(bytes, 0x8000));
  }
  const { step } = await moduleFor(liftObservedShapes(shapes).javascript);
  const machine = new Machine(new RamBus(bytes));
  machine.pc = 0x8000;
  step(machine);
  assert.equal(machine.x, 42);
  assert.equal(machine.a, 0);
  machine.bus.write(0x8000, 0xa9);
  machine.bus.write(0x8001, 99);
  machine.pc = 0x8000;
  step(machine);
  assert.equal(machine.a, 99);
  assert.equal(machine.x, 42);
  machine.bus.write(0x8000, 0xa0);
  machine.pc = 0x8000;
  assert.throws(() => step(machine), /not recovered/);
  machine.bus.write(0x9000, 0xa9);
  machine.pc = 0x9000;
  assert.throws(() => step(machine), /not recovered/);
});
