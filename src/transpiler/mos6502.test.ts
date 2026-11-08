import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, OPCODES, branchTarget, disassemble, type Instruction } from './mos6502.js';
import { lift } from './lift.js';
import { ExecutionGap, Machine, RamBus } from '../runtime/mos6502.js';
import { AddressSpace } from '../memory.js';

async function program(
  bytes: number[],
  start = 0x8000,
): Promise<{ machine: Machine; step: (machine: Machine) => void; ram: Uint8Array }> {
  const bus = new RamBus();
  bus.bytes.set(bytes, start);
  const instructions: Instruction[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const i = decode(bus.bytes, start + offset);
    instructions.push(i);
    offset += i.size;
  }
  const source = lift(instructions);
  const compiled = (await import(
    `data:text/javascript;base64,${Buffer.from(source.javascript).toString('base64')}`
  )) as { step: (machine: Machine) => void };
  const machine = new Machine(bus);
  machine.pc = start;
  return { machine, step: compiled.step, ram: bus.bytes };
}

test('exactly 151 documented NMOS opcodes decode, and CMOS/illegal opcodes fail', () => {
  assert.equal(OPCODES.size, 151);
  const memory = new Uint8Array(65536);
  for (const [opcode, spec] of OPCODES) {
    memory[0] = opcode;
    memory[1] = 0x34;
    memory[2] = 0x12;
    assert.equal(decode(memory, 0).bytes.length, spec.size);
  }
  memory[0] = 0x02;
  assert.throws(() => decode(memory, 0), /Unsupported NMOS opcode/);
  memory[65535] = 0xad;
  memory[0] = 0x34;
  memory[1] = 0x12;
  assert.equal(decode(memory, 65535).text, 'LDA $1234');
});
test('branches sign-extend and wrap; taken branches add page-cross cycles', async () => {
  assert.equal(branchTarget(0, 0xfc), 65534);
  const { machine, step } = await program([0xd0, 0xfc], 0x8100);
  machine.p = 0x20;
  step(machine);
  assert.equal(machine.pc, 0x80fe);
  assert.equal(machine.cycles, 4);
  machine.pc = 0x8100;
  machine.p |= 2;
  step(machine);
  assert.equal(machine.pc, 0x8102);
  assert.equal(machine.cycles, 6);
});
test('indexed loads cross pages, indexed stores keep fixed timing', async () => {
  const { machine, step, ram } = await program([0xbd, 0xff, 0x20, 0x9d, 0xff, 0x30]);
  machine.x = 1;
  ram[0x2100] = 0x80;
  step(machine);
  assert.equal(machine.a, 128);
  assert.equal(machine.cycles, 5);
  assert.equal(machine.p & 128, 128);
  step(machine);
  assert.equal(ram[0x3100], 128);
  assert.equal(machine.cycles, 10);
});
test('zero-page indirect pointers and NMOS indirect JMP wrap correctly', async () => {
  const { machine, step, ram } = await program([0xb1, 0xff, 0x6c, 0xff, 0x12]);
  ram[255] = 0xfe;
  ram[0] = 0x20;
  ram[0x20ff] = 0x65;
  machine.y = 1;
  step(machine);
  assert.equal(machine.a, 0x65);
  ram[0x12ff] = 0x78;
  ram[0x1200] = 0x56;
  ram[0x1300] = 0x99;
  step(machine);
  assert.equal(machine.pc, 0x5678);
});
test('ADC/SBC binary arithmetic agrees with independent exhaustive arithmetic expectations', () => {
  const m = new Machine(new RamBus());
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      for (let carry = 0; carry < 2; carry++) {
        m.a = a;
        m.p = 0x20 | carry;
        m.adc(b);
        const signedSum = (a < 128 ? a : a - 256) + (b < 128 ? b : b - 256) + carry;
        assert.equal(m.a, (a + b + carry) % 256);
        assert.equal(!!(m.p & 1), a + b + carry >= 256);
        assert.equal(!!(m.p & 64), signedSum > 127 || signedSum < -128);
        assert.equal(!!(m.p & 2), m.a === 0);
        assert.equal(!!(m.p & 128), m.a >= 128);
        m.a = a;
        m.p = 0x20 | carry;
        m.sbc(b);
        const signedDifference = (a < 128 ? a : a - 256) - (b < 128 ? b : b - 256) - (1 - carry);
        assert.equal(m.a, (a - b - (1 - carry) + 256) % 256);
        assert.equal(!!(m.p & 1), a - b - (1 - carry) >= 0);
        assert.equal(!!(m.p & 64), signedDifference > 127 || signedDifference < -128);
      }
    }
  }
});
test('JSR/RTS maintain a wrapping stack and restore source addresses', async () => {
  const { machine, step, ram } = await program([0x20, 0x06, 0x80, 0xea, 0xea, 0xea, 0x60]);
  machine.sp = 0;
  step(machine);
  assert.equal(machine.sp, 254);
  assert.equal(ram[0x100], 0x80);
  assert.equal(ram[0x1ff], 2);
  step(machine);
  assert.equal(machine.pc, 0x8003);
  assert.equal(machine.sp, 0);
  assert.equal(machine.cycles, 12);
});
test('RMW issues the NMOS dummy write before its result', async () => {
  const { machine, step, ram } = await program([0xee, 0x00, 0x20]);
  const writes: [number, number][] = [];
  const bus = machine.bus;
  const original = bus.write.bind(bus);
  bus.write = (address, value) => {
    writes.push([address, value]);
    original(address, value);
  };
  ram[0x2000] = 255;
  step(machine);
  assert.deepEqual(writes, [
    [0x2000, 255],
    [0x2000, 0],
  ]);
  assert.equal(machine.p & 2, 2);
});
test('translated code rejects stale operands before execution', async () => {
  const { machine, step, ram } = await program([0xa9, 0x42]);
  ram[0x8001] = 0x43;
  assert.throws(
    () => step(machine),
    (error: unknown) => error instanceof ExecutionGap && error.kind === 'stale-code',
  );
  assert.equal(machine.a, 0);
  assert.equal(machine.cycles, 0);
});
test('CFG follows both branches but leaves indirect control and absent bytes unresolved', () => {
  const space = new AddressSpace();
  space.loadPrg(Uint8Array.from([0x00, 0x80, 0xd0, 3, 0x4c, 0, 0x90, 0x6c, 0, 0x20]));
  const cfg = disassemble(space, [0x8000]);
  assert.deepEqual(
    cfg.instructions.map((i) => i.address),
    [0x8000, 0x8002, 0x8005],
  );
  assert.ok(cfg.unresolved.some((gap) => gap.kind === 'indirect'));
  assert.ok(cfg.unresolved.some((gap) => gap.address === 0x9000 && gap.kind === 'unmapped'));
});
