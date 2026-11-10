import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Recovery } from './n64-recovery.js';

test('native idle hints appear after observing the original branch and include its delay slot', () => {
  const recovery = new N64Recovery(),
    ram = new Vr4300Ram(8192);
  ram.write32(0x80000000, 0x1000ffff);
  ram.write32(0x80000004, 0);
  const machine = new Vr4300Machine(ram, 0x80000000);
  assert.equal(recovery.idleAddresses.size, 0);
  recovery.stepCpu(machine);
  assert.deepEqual([...recovery.idleAddresses], [0x80000000, 0x80000004]);
  assert.equal(machine.pc, 0x80000004);
  assert.equal(machine.inBranchDelaySlot, true);
});
import { Vr4300Machine, Vr4300Ram, Vr4300Gap } from '../runtime/vr4300.js';
import { importStaticProgram } from './program.js';

test('paged N64 recovery preserves branch delay, word variants and unvisited coverage separately', async () => {
  const recovery = new N64Recovery(),
    ram = new Vr4300Ram(8192);
  ram.write32(0x80000000, 0x08000400); // J across a source-address page.
  ram.write32(0x80000004, 0x24030003); // ADDIU v1,zero,3 in the delay slot.
  ram.write32(0x80001000, 0x24020007);
  ram.write32(0x80001004, 0x24040005); // Unvisited but included in the envelope.
  recovery.includeCpuMemory(ram.bytes, 0x80000000, 0x80000008);
  recovery.includeCpuMemory(ram.bytes, 0x80001000, 0x80001008);
  const native = new Vr4300Machine(ram, 0x80000000);
  recovery.stepCpu(native);
  recovery.stepCpu(native);
  recovery.stepCpu(native);
  ram.write32(0x80001000, 0x24020009);
  const alternate = new Vr4300Machine(ram, 0x80001000);
  recovery.stepCpu(alternate);
  const program = recovery.emit().cpu,
    staticProgram = await importStaticProgram<Vr4300Machine>(program);
  const replay = new Vr4300Machine(ram, 0x80000000);
  staticProgram.step(replay);
  staticProgram.step(replay);
  staticProgram.step(replay);
  assert.equal(replay.r32(2), 9);
  assert.equal(replay.r32(3), 3);
  staticProgram.step(replay);
  assert.equal(replay.r32(4), 5);
  assert.equal(Object.keys(program.modules).length, 2);
  assert.equal(recovery.observations('cpu').length, 4);
  assert.equal(
    recovery.observations('cpu').some((o) => o.address === 0x80001004),
    false,
  );
  assert.ok(
    recovery
      .observations('cpu')
      .every((o) => o.sourceFile === `pages/${Math.floor(o.address / 4096).toString(16)}000.ts`),
  );
  const changed = new Vr4300Machine(ram, 0x80001000);
  ram.write32(0x80001000, 0x2402000b);
  assert.throws(
    () => staticProgram.step(changed),
    (error: unknown) => error instanceof Vr4300Gap && error.kind === 'uncompiled-instruction',
  );
});
