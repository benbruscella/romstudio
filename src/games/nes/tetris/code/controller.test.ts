import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableButtons } from './controller.js';
import { Machine, RamBus } from '../../../../runtime/mos6502.js';
import { decode } from '../../../../transpiler/mos6502.js';
import { lift } from '../../../../transpiler/lift.js';

test('named Tetris input interpretation matches the original two-player filter and edge handler', async () => {
  // Pinned original $ABCB–$ABE7. End before RTS so no synthetic caller affects
  // the comparison. The original handler updates player 2, then player 1.
  const bytes = [
    0xa5, 0xf5, 0x25, 0xa9, 0x85, 0xf5, 0xa5, 0xf6, 0x25, 0xaa, 0x85, 0xf6, 0xa2, 1, 0xb5, 0xf5,
    0xa8, 0x55, 0xf7, 0x35, 0xf5, 0x95, 0xf5, 0x94, 0xf7, 0xca, 0x10, 0xf2, 0x60,
  ];
  const bus = new RamBus();
  bus.bytes.set(bytes, 0xabcb);
  const instructions = [];
  for (let at = 0xabcb; at < 0xabe7;) {
    const instruction = decode(bus.bytes, at);
    instructions.push(instruction);
    at += instruction.size;
  }
  const source = lift(instructions).javascript;
  const { step } = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as { step(machine: Machine): void };
  for (const first of [0, 1, 0x80, 0x55, 0xaa, 255]) {
    for (const second of [0, 1, 0x80, 0x55, 0xaa, 255]) {
      for (const previous of [0, 0x55, 255]) {
        const machine = new Machine(bus);
        machine.pc = 0xabcb;
        const cases = [
          [first, second, previous],
          [first ^ 255, second ^ 255, previous ^ 255],
        ];
        for (let player = 0; player < 2; player++) {
          const [a, b, old] = cases[player]!;
          bus.bytes[0xa9 + player] = a!;
          bus.bytes[0xf5 + player] = b!;
          bus.bytes[0xf7 + player] = old!;
        }
        while (machine.pc !== 0xabe7) {
          step(machine);
        }
        for (let player = 0; player < 2; player++) {
          const [a, b, old] = cases[player]!,
            named = stableButtons(a!, b!, old!);
          assert.equal(bus.bytes[0xf5 + player], named.pressed);
          assert.equal(bus.bytes[0xf7 + player], named.held);
        }
      }
    }
  }
});
