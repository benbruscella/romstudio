import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressSpace } from '../../memory.js';
import { C64SystemBus } from './system.js';
import { applyC64Controls, replayC64Controls } from './input.js';
import { ExecutionGap } from '../../runtime/mos6502.js';

test('shared controller input drives joystick pins and the keyboard matrix on either port', () => {
  const bus = new C64SystemBus(new AddressSpace());
  applyC64Controls(bus, { joystick: 247, keys: [27] });
  assert.equal(bus.cia1.inputA, 247);
  assert.deepEqual([...bus.cia1.pressedKeys], [27]);
  bus.cia1.write(0, 0xf7);
  assert.equal(bus.cia1.read(1) & 8, 0);
  applyC64Controls(bus, { joystick: 239, keys: [] }, 1);
  assert.equal(bus.cia1.inputB, 239);
  assert.equal(bus.cia1.pressedKeys.size, 0);
  assert.throws(
    () => applyC64Controls(bus, { joystick: 300, keys: [] }),
    (e: unknown) => e instanceof ExecutionGap && e.kind === 'input-profile',
  );
  assert.throws(
    () => applyC64Controls(bus, { joystick: 255, keys: [64] }),
    /Invalid C64 controller/,
  );
});
test('shared input logs retain held switches and apply every event through a requested control boundary', () => {
  const input = replayC64Controls([
    { frame: 2, joystick: 247, keys: [27] },
    { frame: 5, joystick: 239, keys: [] },
    { frame: 6, joystick: 255, keys: [] },
  ]);
  assert.deepEqual(input(1), { joystick: 255, keys: [] });
  assert.deepEqual(input(3), { joystick: 247, keys: [27] });
  assert.deepEqual(input(6), { joystick: 255, keys: [] });
  assert.deepEqual(input(20), { joystick: 255, keys: [] });
});
