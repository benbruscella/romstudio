import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EliteStartup } from './startup.js';
import { AddressSpace } from '../../../../memory.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { decode } from '../../../../transpiler/mos6502.js';
import { lift } from '../../../../transpiler/lift.js';

const bytes = [
  0xb1, 0xfe, 0xa4, 0xfe, 0xd0, 2, 0xc6, 0xff, 0xc6, 0xfe, 0xc0, 0xef, 0xd0, 0x0e, 0xa4, 0xff, 0xc0,
  7, 0xd0, 8, 0xa9, 0x37, 0x85, 1, 0x58, 0x4c, 1, 8,
];
test('Elite marker exit discards the unknown read without fabricating a RAM value', async () => {
  const prepare = (marker?: number) => {
    const space = new AddressSpace();
    space.loadPrg(Uint8Array.from([0x88, 1, ...bytes]));
    const bus = new C64SystemBus(space),
      machine = new Machine(bus);
    bus.seed(0xfe, 0xef);
    bus.seed(0xff, 7);
    if (marker !== undefined) {
      bus.seed(0x7ef, marker);
    }
    machine.pc = 0x188;
    machine.a = 0x53;
    machine.y = 0;
    machine.p = 0x24;
    return { bus, machine };
  };
  const scratch = new Uint8Array(65536);
  scratch.set(bytes, 0x188);
  const instructions = [];
  for (let at = 0x188; at < 0x188 + bytes.length;) {
    const instruction = decode(scratch, at);
    instructions.push(instruction);
    at += instruction.size;
  }
  const source = lift(instructions).javascript;
  const { step } = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as { step(machine: Machine): void };
  const annotated = prepare(),
    title = new EliteStartup(annotated.bus);
  assert.equal(title.boundary(annotated.machine), true);
  while (annotated.machine.pc !== 0x801) {
    step(annotated.machine);
  }
  for (const marker of [0, 255, 0x7f]) {
    const original = prepare(marker);
    while (original.machine.pc !== 0x801) {
      step(original.machine);
    }
    assert.deepEqual(annotated.machine.snapshot(), original.machine.snapshot());
    assert.deepEqual(
      [...annotated.bus.bytes.subarray(0xfc, 0x100)],
      [...original.bus.bytes.subarray(0xfc, 0x100)],
    );
  }
  assert.equal(annotated.bus.known[0x7ef], 0);
  assert.equal(title.discardedMarkerReads, 1);
});
