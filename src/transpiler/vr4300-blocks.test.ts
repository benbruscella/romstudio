import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileVr4300, decodeVr4300 } from './vr4300.js';
import { emitVr4300Blocks } from './vr4300-blocks.js';
import { Vr4300Machine, Vr4300Ram } from '../runtime/vr4300.js';

type Block = (machine: Vr4300Machine, words: Int32Array, ram: DataView) => number;

function program(base: number, words: readonly number[]) {
  const instructions = words.map((word, i) => decodeVr4300(word, base + i * 4));
  const machine = () => {
    const ram = new Vr4300Ram();
    words.forEach((word, i) =>
      new DataView(ram.bytes.buffer).setUint32((base & 0x1fffffff) + i * 4, word >>> 0, false),
    );
    const cpu = new Vr4300Machine(ram, base);
    cpu.set32(31, 0x80002000); // Return address ends both runs.
    return { ram, cpu };
  };
  return { instructions, machine };
}

async function compare(base: number, words: readonly number[]) {
  const { instructions, machine } = program(base, words);
  const reference = machine();
  const steps = new Map(instructions.map((i) => [i.address, compileVr4300(i)]));
  while (reference.cpu.pc !== 0x80002000) {
    steps.get(reference.cpu.pc)!(reference.cpu);
  }
  const emitted = emitVr4300Blocks(instructions, [base]);
  // Parts are standalone modules; the index only merges their maps.
  const blocks = new Map<number, Block>();
  for (const part of emitted.parts) {
    const module = (await import('data:text/javascript,' + encodeURIComponent(part))) as {
      blocks: Map<number, Block>;
    };
    for (const [address, block] of module.blocks) {
      blocks.set(address, block);
    }
  }
  const compiled = machine();
  const words32 = new Int32Array(compiled.cpu.registers.buffer);
  const view = new DataView(compiled.ram.bytes.buffer);
  let runs = 0;
  while (compiled.cpu.pc !== 0x80002000) {
    const block = blocks.get(compiled.cpu.pc);
    assert.ok(block, `no block at ${compiled.cpu.pc.toString(16)}`);
    assert.ok(block(compiled.cpu, words32, view) > 0);
    runs++;
  }
  return { reference, compiled, runs, blocks, view };
}

const signedProgram = [
  0x3c088000, // LUI   $t0, $8000          ; sign-extended KSEG0 base
  0x35082000, // ORI   $t0, $t0, $2000
  0x2409fffb, // ADDIU $t1, $zero, -5
  0x0129502d, // DADDU $t2, $t1, $t1       ; 64-bit carry across halves
  0xad090004, // SW    $t1, 4($t0)          ; direct RDRAM store
  0x8d0b0004, // LW    $t3, 4($t0)
  0x0120602a, // SLT   $t4, $t1, $zero
  0x01206827, // NOR   $t5, $t1, $zero
  0x15200002, // BNE   $t1, $zero, +2       ; taken
  0x240e0007, // ADDIU $t6, $zero, 7        ; delay slot
  0x240f0001, // ADDIU $t7, $zero, 1        ; skipped
  0x0009c03c, // DSLL32 $t8, $t1, 0
  0x03e00008, // JR    $ra
  0x0018c83f, // DSRA32 $t9, $t8, 0         ; delay slot
];

test('compiled blocks match per-instruction execution, including 64-bit halves and delay slots', async () => {
  const { reference, compiled, runs } = await compare(0x80001000, signedProgram);
  assert.equal(runs, 2);
  assert.deepEqual([...compiled.cpu.registers], [...reference.cpu.registers]);
  assert.equal(compiled.cpu.instructions, reference.cpu.instructions);
  assert.equal(compiled.cpu.instructions, 13);
  assert.deepEqual(
    compiled.ram.bytes.subarray(0x2000, 0x2008),
    reference.ram.bytes.subarray(0x2000, 0x2008),
  );
  assert.equal(compiled.cpu.r32(14), 7); // Delay slot ran; skipped instruction did not.
  assert.equal(compiled.cpu.r32(15), 0);
});

test('a not-taken branch-likely nullifies its slot and a changed word refuses the block', async () => {
  const words = [
    0x24090003, // ADDIU $t1, $zero, 3
    0x51200002, // BEQL  $t1, $zero, +2        ; not taken
    0x240e0007, // ADDIU $t6, $zero, 7         ; nullified
    0x03e00008, // JR    $ra
    0x00000000, // NOP
  ];
  const { reference, compiled, blocks, view } = await compare(0x80001000, words);
  assert.deepEqual([...compiled.cpu.registers], [...reference.cpu.registers]);
  assert.equal(compiled.cpu.instructions, reference.cpu.instructions);
  assert.equal(compiled.cpu.r32(14), 0);

  view.setUint32(0x1000, 0x24090004, false); // Change the first original word.
  const cpu = new Vr4300Machine(new Vr4300Ram(), 0x80001000);
  assert.equal(blocks.get(0x80001000)!(cpu, new Int32Array(cpu.registers.buffer), view), 0);
  assert.equal(cpu.pc, 0x80001000);
});
