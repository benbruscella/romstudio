import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Memory } from './memory.js';
import { rdpCommandBytes } from './display.js';

function submit(memory: N64Memory, words: number[][]) {
  words.forEach(([high, low], i) => {
    memory.ram.write32(i * 8, high!);
    memory.ram.write32(i * 8 + 4, low!);
  });
  memory.write32(0x04100000, 0);
  memory.write32(0x04100004, words.length * 8);
}

test('RDP fill cycle clips RGBA16 pixels and selects packed colors by RDRAM word position', () => {
  const memory = new N64Memory(new Uint8Array(0));
  memory.ram.bytes.fill(0x55, 0xf8, 0x130);
  submit(memory, [
    [0xef300000, 0], // Fill cycle.
    [0xed004004, 0x0001000c], // Scissor [1,1) to [4,3), exclusive right/bottom.
    [0xff100004, 0x100], // RGBA16, five pixels per row.
    [0xf7000000, 0xf80107c1], // Alternating red/green packed halfwords.
    [0xf601000c, 0], // Inclusive rectangle 0,0 through 4,3.
    [0xe9000000, 0],
  ]);
  assert.deepEqual(
    Array.from({ length: 20 }, (_, i) => memory.ram.read16(0x100 + i * 2)),
    [
      0x5555, 0x5555, 0x5555, 0x5555, 0x5555, 0x5555, 0xf801, 0x07c1, 0xf801, 0x5555, 0x5555,
      0x07c1, 0xf801, 0x07c1, 0x5555, 0x5555, 0x5555, 0x5555, 0x5555, 0x5555,
    ],
  );
  assert.ok(memory.ram.bytes.subarray(0xf8, 0x100).every((value) => value === 0x55));
  assert.ok(memory.ram.bytes.subarray(0x128, 0x130).every((value) => value === 0x55));
  assert.equal(memory.display.fullSyncs, 1);
  assert.equal(memory.display.current, 48);
  assert.equal(memory.interrupts.pending & 32, 32);
  memory.write32(0x04300000, 0x800);
  assert.equal(memory.interrupts.pending & 32, 0);
});

test('RDP RGBA32 fill endpoints include a single column and do not touch neighboring pixels', () => {
  const memory = new N64Memory(new Uint8Array(0));
  memory.ram.bytes.fill(0x11, 0x200, 0x220);
  submit(memory, [
    [0xef300000, 0],
    [0xed000000, 0x0000c008], // Scissor 3 by 2 pixels.
    [0xff180002, 0x200], // RGBA32, width three.
    [0xf7000000, 0x12345678],
    [0xf6004004, 0x00004000], // Column x=1, rows 0 and 1.
  ]);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, i) => memory.ram.read32(0x200 + i * 4)),
    [
      0x11111111, 0x12345678, 0x11111111, 0x11111111, 0x12345678, 0x11111111, 0x11111111,
      0x11111111,
    ],
  );
});

test('a draw breakpoint stops at a complete triangle without writing pixels or raising completion', () => {
  const memory = new N64Memory(new Uint8Array(0));
  memory.display.beforeDraw = () => {
    throw new Error('triangle breakpoint');
  };
  assert.throws(
    () =>
      submit(memory, [
        [0xc8000000, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    /triangle breakpoint/,
  );
  assert.equal(memory.display.current, 0);
  assert.equal(memory.display.commands.length, 0);
  assert.equal(memory.interrupts.pending & 32, 0);
});

test('RDP waits for every coefficient word before executing a split triangle packet', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, i) => rdpCommandBytes(8 + i)),
    [32, 48, 96, 112, 96, 112, 160, 176],
  );
  assert.equal(rdpCommandBytes(0x24), 16);
  assert.equal(rdpCommandBytes(0x25), 16);
  const memory = new N64Memory(new Uint8Array(0));
  memory.display.beforeDraw = (command) => {
    throw new Error(`triangle ${command.opcode} ${command.bytes}`);
  };
  submit(memory, [
    [0xcf000000, 0],
    [0xe9000000, 0],
  ]); // The apparent FullSync is coefficient data.
  assert.equal(memory.display.current, 0);
  assert.equal(memory.display.fullSyncs, 0);
  memory.write32(0x04100004, 168);
  assert.equal(memory.display.current, 0);
  assert.throws(() => memory.write32(0x04100004, 176), /triangle 15 176/);
  assert.equal(memory.display.current, 0);
  assert.equal(memory.display.fullSyncs, 0);
  assert.equal(memory.display.commands.length, 0);
});

test('RDP texture commands retain TMEM and bounds through a device checkpoint', () => {
  const memory = new N64Memory(new Uint8Array(0)),
    restored = new N64Memory(new Uint8Array(0));
  memory.ram.write32(0x100, 0xf80107c1);
  memory.ram.write32(0x104, 0x003fffff);
  submit(memory, [
    [0xfd100000, 0x100],
    [0xf5100000, 0x07000000],
    [0xf3000000, 0x07003000],
    [0xf5100200, 0],
    [0xf2000000, 0x0000c000],
  ]);
  assert.equal(memory.display.current, 40);
  restored.display.restore(memory.display.snapshot());
  assert.deepEqual(restored.display.texture.sample(0, 64, 0), [0, 0, 255, 255]);
  assert.deepEqual(restored.display.snapshot(), memory.display.snapshot());
});

test('RDP texture rectangles decode their second word, axes and copy-cycle derivative scale', () => {
  for (const [opcode, cycle, derivative, expected] of [
    [0xe4, 0, 0x04000400, [0xf801, 0x07c1, 0x003f, 0xffff]],
    [0xe5, 0, 0x04000400, [0xf801, 0x003f, 0x07c1, 0xffff]],
    [0xe4, 2, 0x10000400, [0xf801, 0x07c1, 0x003f, 0xffff]],
  ] as const) {
    const memory = new N64Memory(new Uint8Array(0));
    memory.ram.write32(0x800, 0xf80107c1);
    memory.ram.write32(0x808, 0x003fffff);
    memory.ram.bytes.fill(0x55, 0x100, 0x120);
    submit(memory, [
      [0xef000000 | (cycle << 20), 0],
      [0xed000000, 0x00010010],
      [0xff100003, 0x100],
      [0xfcffffff, 0xfffcf279],
      [0xfd100000, 0x800],
      [0xf5100000, 0x07000000],
      [0xf3000000, 0x07007800],
      [0xf5100200, 0x00080200],
      [0xf2000000, 0x00004004],
      [(opcode << 24) | (cycle === 2 ? 0x8008 : 0xc00c), 0x00004004],
      [0, derivative],
      [0xe9000000, 0],
    ]);
    assert.deepEqual(
      [
        memory.ram.read16(0x10a),
        memory.ram.read16(0x10c),
        memory.ram.read16(0x112),
        memory.ram.read16(0x114),
      ],
      expected,
    );
    assert.equal(memory.ram.read16(0x108), 0x5555);
    assert.equal(memory.ram.read16(0x116), 0x5555);
    assert.equal(memory.display.current, 96);
    assert.equal(memory.display.fullSyncs, 1);
  }
});

test('a frozen RDP FIFO resumes from a copied checkpoint without sharing mutable state', () => {
  const original = new N64Memory(new Uint8Array(0)),
    restored = new N64Memory(new Uint8Array(0));
  original.write32(0x0410000c, 8);
  submit(original, [
    [0xef300000, 0],
    [0xed000000, 0x00008004],
    [0xff180001, 0x200],
    [0xf7000000, 0xaabbccdd],
    [0xf6004000, 0],
    [0xe9000000, 0],
  ]);
  assert.equal(original.display.commands.length, 0);
  restored.ram.bytes.set(original.ram.bytes);
  const state = original.display.snapshot();
  restored.display.restore(state);
  state.scissor.right = 999;
  state.stateWords[0] = 123;
  for (const memory of [original, restored]) {
    memory.write32(0x0410000c, 4);
  }
  assert.equal(restored.ram.read32(0x200), 0xaabbccdd);
  assert.equal(restored.ram.read32(0x204), 0xaabbccdd);
  assert.deepEqual(restored.display.snapshot(), original.display.snapshot());
  assert.deepEqual(restored.ram.bytes, original.ram.bytes);
});
