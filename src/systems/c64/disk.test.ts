import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, ExecutionGap } from '../../runtime/mos6502.js';
import { AddressSpace } from '../../memory.js';
import { C64SystemBus } from './system.js';
import { loadDiskPrg } from './disk.js';
test('pinned-file LOAD respects the secondary address, returns the end pointer and rejects unsupported operations', () => {
  for (const secondary of [0, 8]) {
    const bus = new C64SystemBus(new AddressSpace()),
      s = new Machine(bus);
    for (const [address, value] of [
      [0xb7, 1],
      [0xbb, 0],
      [0xbc, 2],
      [0x200, 0x54],
      [0xba, 8],
      [0xb9, secondary],
    ]) {
      s.write(address!, value!);
    }
    s.a = 0;
    s.x = 0;
    s.y = 0x20;
    s.push(0x80);
    s.push(0);
    s.pc = 0xffd5;
    const files = new Map([
      [
        'T',
        {
          bytes: Uint8Array.from([1, 8, 0x42, 0x43]),
          mediaHash: 'a'.repeat(64),
          fileId: 'fixture',
        },
      ],
    ]);
    const record = loadDiskPrg(s, files),
      start = secondary ? 0x801 : 0x2000;
    assert.deepEqual([...bus.bytes.subarray(start, start + 2)], [0x42, 0x43]);
    assert.equal(record.start, start);
    assert.equal(record.end, start + 2);
    assert.equal(s.word(0xae), start + 2);
    assert.equal(s.pc, 0x8001);
    assert.equal(s.p & 1, 0);
    assert.equal((s.y << 8) | s.x, start + 2);
    s.a = 1;
    assert.throws(
      () => loadDiskPrg(s, files),
      (error: unknown) => error instanceof ExecutionGap && error.kind === 'disk-verify',
    );
    s.a = 0;
    assert.throws(() => loadDiskPrg(s, new Map()), /not present on the pinned disk/);
    s.write(0xba, 9);
    assert.throws(() => loadDiskPrg(s, files), /drive 8/);
  }
});
