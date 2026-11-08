import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vr4300Machine, Vr4300Ram, Vr4300Gap, type Vr4300Program } from './vr4300.js';
import { decodeVr4300, liftVr4300, liftVr4300Pages, compileVr4300 } from '../transpiler/vr4300.js';
import { importStaticProgram } from '../transpiler/program.js';

test('idle metadata retains both phases across source pages without authorizing other branches', async () => {
  const instructions = [
    decodeVr4300(0x1000ffff, 0x80000ffc),
    decodeVr4300(0, 0x80001000),
    decodeVr4300(0x1021ffff, 0x80002000), // BEQ $at,$at,-1 needs ordinary execution.
  ];
  for (const lift of [liftVr4300, liftVr4300Pages]) {
    const program = (await importStaticProgram<Vr4300Machine>(lift(instructions))) as Vr4300Program;
    assert.deepEqual([...program.idleAddresses!], [0x80000ffc, 0x80001000]);
  }
});

test('specialized dispatch keeps word guards, variants and page caching across machines', async () => {
  const first = decodeVr4300(0x24020001, 0x80000000),
    alternate = decodeVr4300(0x24020003, 0x80000000),
    second = decodeVr4300(0x24020002, 0x80001000);
  for (const lift of [liftVr4300, liftVr4300Pages]) {
    const program = await importStaticProgram<Vr4300Machine>(lift([first, alternate, second]));
    const ram = new Vr4300Ram(8192);
    for (const instruction of [first, second, alternate, first]) {
      ram.write32(instruction.address, instruction.word);
      const machine = new Vr4300Machine(ram, instruction.address);
      program.step(machine);
      assert.equal(machine.r32(2), instruction.signedImmediate);
      assert.equal(machine.instructions, 1);
    }
    ram.write32(second.address, 0x24020007);
    const changed = new Vr4300Machine(ram, second.address),
      before = changed.snapshot();
    assert.throws(() => program.step(changed), Vr4300Gap);
    assert.deepEqual(changed.snapshot(), before);
    const direct = compileVr4300(second);
    assert.throws(() => direct(changed), Vr4300Gap);
    assert.deepEqual(changed.snapshot(), before);
  }
});

const immediate = (op: number, rs: number, rt: number, value: number) =>
  ((op << 26) | (rs << 21) | (rt << 16) | (value & 65535)) >>> 0;
const special = (operation: number, rs: number, rt: number, rd = 0, shift = 0) =>
  ((rs << 21) | (rt << 16) | (rd << 11) | (shift << 6) | operation) >>> 0;
const floating = (
  format: number,
  operation: number,
  destination: number,
  left: number,
  right = 0,
) =>
  ((17 << 26) | (format << 21) | (right << 16) | (left << 11) | (destination << 6) | operation) >>>
  0;
async function fixture(words: number[]) {
  const bus = new Vr4300Ram(4096);
  words.forEach((word, index) => bus.write32(0x80000000 + index * 4, word));
  const generated = liftVr4300(
    words.map((word, index) => decodeVr4300(word, 0x80000000 + index * 4)),
  );
  return {
    bus,
    machine: new Vr4300Machine(bus, 0x80000000),
    ...(await importStaticProgram<Vr4300Machine>(generated)),
  };
}

test('VR4300 word arithmetic sign-extends into 64-bit registers and preserves register zero', async () => {
  const { machine, step } = await fixture([
    immediate(15, 0, 8, 0x8000),
    immediate(9, 8, 8, -1),
    immediate(13, 0, 0, 0xffff),
  ]);
  step(machine);
  assert.equal(machine.r(8), -0x80000000n);
  step(machine);
  assert.equal(machine.r(8), 0x7fffffffn);
  step(machine);
  assert.equal(machine.r(0), 0n);
  assert.equal(machine.registers[0], 0n);
});

test('VR4300 doubleword operations retain bits beyond JavaScript Number precision', async () => {
  const word = ((8 << 21) | (9 << 16) | (10 << 11) | 0x2d) >>> 0;
  const { machine, step } = await fixture([word]);
  machine.set64(8, 0x100000000000001n);
  machine.set64(9, 0x200000000000002n);
  step(machine);
  assert.equal(machine.r(10), 0x300000000000003n);
});

test('ordinary branches execute the delay slot and an untaken likely branch annuls it', async () => {
  const taken = await fixture([
    immediate(4, 1, 1, 1),
    immediate(9, 0, 2, 7),
    immediate(9, 0, 3, 9),
  ]);
  taken.step(taken.machine);
  assert.equal(taken.machine.pc, 0x80000004);
  assert.equal(taken.machine.r(2), 0n);
  taken.step(taken.machine);
  assert.equal(taken.machine.r(2), 7n);
  assert.equal(taken.machine.pc, 0x80000008);
  const likely = await fixture([
    immediate(20, 1, 0, 1),
    immediate(9, 0, 2, 7),
    immediate(9, 0, 3, 9),
  ]);
  likely.machine.set32(1, 1);
  likely.step(likely.machine);
  assert.equal(likely.machine.pc, 0x80000008);
  likely.step(likely.machine);
  assert.equal(likely.machine.r(2), 0n);
  assert.equal(likely.machine.r(3), 9n);
});

test('signed ADDI traps before writing its destination and aligned RAM is big-endian', async () => {
  const { machine, step, bus } = await fixture([immediate(8, 1, 2, 1)]);
  machine.set32(1, 0x7fffffff);
  machine.set32(2, 123);
  assert.throws(
    () => step(machine),
    (error) => error instanceof Vr4300Gap && error.kind === 'integer-overflow',
  );
  assert.equal(machine.r(2), 123n);
  assert.equal(machine.pc, 0x80000000);
  bus.write32(0x80000100, 0x12345678);
  assert.deepEqual([...bus.bytes.subarray(0x100, 0x104)], [0x12, 0x34, 0x56, 0x78]);
  assert.equal(bus.read32(0xa0000100), 0x12345678);
  assert.throws(() => bus.read32(0x80000101), /Unaligned/);
});

test('MIPS jump targets take their upper bits from PC plus four', () => {
  assert.equal(decodeVr4300(0x08000000, 0x8ffffffc).target, 0x90000000);
  assert.throws(() => decodeVr4300(0, 0x80000001), /aligned/);
});

test('left/right memory instructions merge only selected bytes at every big-endian alignment', async () => {
  for (const width of [4, 8] as const) {
    const leftLoad = width === 4 ? 34 : 26,
      rightLoad = width === 4 ? 38 : 27,
      leftStore = width === 4 ? 42 : 44,
      rightStore = width === 4 ? 46 : 45;
    const registerBytes = [0x89, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78].slice(0, width);
    const registerValue = registerBytes.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
    for (let alignment = 0; alignment < width; alignment++) {
      for (const left of [true, false]) {
        const f = await fixture([
          immediate(left ? leftLoad : rightLoad, 1, 2, alignment),
          immediate(left ? leftStore : rightStore, 1, 3, alignment),
        ]);
        const original = Array.from({ length: width }, (_, i) => 0x20 + i);
        f.bus.bytes.set(original, 0x100);
        f.machine.set32(1, 0x80000100);
        f.machine.set64(2, registerValue);
        f.machine.set64(3, registerValue);
        f.step(f.machine);
        const merged = left
          ? [...original.slice(alignment), ...registerBytes.slice(width - alignment)]
          : [...registerBytes.slice(0, width - alignment - 1), ...original.slice(0, alignment + 1)];
        const expected = merged.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
        assert.equal(f.machine.r(2), BigInt.asIntN(width * 8, expected));
        f.step(f.machine);
        assert.deepEqual(
          [...f.bus.bytes.subarray(0x100, 0x100 + width)],
          left
            ? [...original.slice(0, alignment), ...registerBytes.slice(0, width - alignment)]
            : [...registerBytes.slice(width - alignment - 1), ...original.slice(alignment + 1)],
        );
      }
      const pair = await fixture([
        immediate(leftStore, 1, 2, alignment),
        immediate(rightStore, 1, 2, alignment + width - 1),
        immediate(rightLoad, 1, 3, alignment + width - 1),
        immediate(leftLoad, 1, 3, alignment),
      ]);
      pair.bus.bytes.fill(0x55, 0x100, 0x120);
      pair.machine.set32(1, 0x80000100);
      pair.machine.set64(2, registerValue);
      for (let i = 0; i < 4; i++) {
        pair.step(pair.machine);
      }
      assert.equal(pair.machine.r(3), BigInt.asIntN(width * 8, registerValue));
      assert.deepEqual(
        [...pair.bus.bytes.subarray(0x100, 0x100 + width * 2)],
        [
          ...Array<number>(alignment).fill(0x55),
          ...registerBytes,
          ...Array<number>(width - alignment).fill(0x55),
        ],
      );
    }
  }
});

test('integer multiplication, division and 64-bit shifts preserve architectural HI/LO widths', async () => {
  const { machine, step } = await fixture([
    special(0x19, 1, 2),
    special(0x1c, 3, 4),
    special(0x1a, 5, 6),
    special(0x3f, 0, 7, 8, 4),
  ]);
  machine.set32(1, 0xffffffff);
  machine.set32(2, 2);
  step(machine);
  assert.equal(machine.hi, 1n);
  assert.equal(machine.lo, -2n);
  machine.set64(3, -(1n << 60n));
  machine.set64(4, 16n);
  step(machine);
  assert.equal(machine.hi, -1n);
  assert.equal(machine.lo, 0n);
  machine.set32(5, -17);
  machine.set32(6, 5);
  step(machine);
  assert.equal(machine.lo, -3n);
  assert.equal(machine.hi, -2n);
  machine.set64(7, -0x123456789000000n);
  step(machine);
  assert.equal(machine.r(8), -0x123457n);
});

test('a linked branch evaluates its source before replacing the return register', async () => {
  const { machine, step } = await fixture([immediate(1, 31, 17, 2), 0, 0, 0]);
  machine.set64(31, 1n);
  step(machine);
  assert.equal(machine.nextPc, 0x8000000c);
  assert.equal(machine.r(31), -0x7ffffff8n);
});

test('CP1 paired words, raw doubleword memory and exact arithmetic retain their formats', async () => {
  const { machine, step, bus } = await fixture([
    immediate(53, 1, 4, 0),
    floating(16, 2, 6, 4, 8),
    floating(20, 32, 10, 12),
    floating(16, 13, 14, 6),
  ]);
  machine.control.write(12, 0x20000000);
  machine.set32(1, 0x80000100);
  bus.write64(0x80000100, 0x400000003fc00000n);
  step(machine);
  assert.equal(machine.fpu.word(4), 0x3fc00000); // Low word: 1.5f
  assert.equal(machine.fpu.word(5), 0x40000000); // High word: 2.0f
  machine.fpu.setWord(8, 0x40200000); // 2.5f
  step(machine);
  assert.equal(machine.fpu.word(6), 0x40700000); // 3.75f
  machine.fpu.setWord(12, 16777217);
  step(machine);
  assert.equal(machine.fpu.word(10), 0x4b800000);
  assert.equal(machine.fcsr & 0x1004, 0x1004);
  step(machine);
  assert.equal(machine.fpu.word(14), 3);
  assert.equal(machine.fcsr & 0x1004, 0x1004);
});

test('enabled FPU exceptions preserve destinations and paired/full register modes differ', async () => {
  const { machine, step } = await fixture([floating(16, 3, 6, 2, 4)]);
  machine.control.write(12, 0x24000000);
  machine.fpu.setWord(2, 0x3f800000);
  machine.fpu.setWord(3, 0x40000000);
  assert.equal(machine.fpu.word(2), 0x3f800000);
  assert.equal(machine.fpu.word(3), 0x40000000);
  machine.fpu.setWord(4, 0);
  machine.fpu.setWord(6, 0x12345678);
  machine.fcsr = 0x400; // Enable division by zero.
  assert.throws(() => step(machine), /Enabled floating-point exception/);
  assert.equal(machine.fpu.word(6), 0x12345678);
  assert.equal(machine.fcsr & 0x8000, 0x8000);
  assert.equal(machine.pc, 0x80000000);
});

test('CP0 masks pending interrupts, saves a delay-slot EPC and ERET has no delay slot', async () => {
  const { machine, step, bus } = await fixture([immediate(4, 0, 0, 3), 0, 0, 0, 0]);
  machine.control.write(12, 0x400);
  assert.equal(machine.checkInterrupts(true), false);
  step(machine);
  machine.control.write(12, 0x401);
  assert.equal(machine.checkInterrupts(true), true);
  assert.equal(machine.pc, 0x80000180);
  assert.equal(machine.control.read(14), 0x80000000);
  assert.equal(machine.control.read(13) >>> 31, 1);
  bus.write32(0x80000180, 0x42000018);
  const returnProgram = await importStaticProgram<Vr4300Machine>(
    liftVr4300([decodeVr4300(0x42000018, 0x80000180)]),
  );
  returnProgram.step(machine);
  assert.equal(machine.pc, 0x80000000);
  assert.equal(machine.nextPc, 0x80000004);
  assert.equal(machine.control.read(12) & 7, 1);
});
