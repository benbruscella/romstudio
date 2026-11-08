import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RspMachine, type RspBus, type RspProgram } from './rsp.js';
import { decodeRsp, liftRsp } from '../transpiler/rsp.js';
import { importStaticProgram } from '../transpiler/program.js';
import {
  rspReciprocal,
  rspReciprocalSquareRoot,
  rspSquareRootSignificands,
} from './rsp-reciprocal.js';

test('RSP reciprocal square root follows ROM bank/exponent selection and exceptional signed inputs', () => {
  // Pinned after independently comparing every word with the published
  // RSQ_ROM table (Dillonb/n64-resources/rsp.md), packed as 512 BE halfwords.
  const rom = Buffer.alloc(1024);
  rspSquareRootSignificands.forEach((value, index) => rom.writeUInt16BE(value - 65536, index * 2));
  assert.equal(
    createHash('sha256').update(rom).digest('hex'),
    'd82dd8058b8cad65c6fed29b91de3db628f873de4a36f12003111ac8cbef12f6',
  );
  const cases = [
    [0, 0x7fffffff],
    [1, 0x7fffc000],
    [2, 0x5a824000],
    [4, 0x3fffe000],
    [16, 0x1ffff000],
    [-1, 0x80003fff],
    [-2, 0xa57dbfff],
    [-32768, 0xffff0000],
  ];
  for (const [input, output] of cases) {
    assert.equal(rspReciprocalSquareRoot(input!), output);
  }
});

test('RSP reciprocal and square-root instructions share their latches across mixed pairs and checkpoints', async () => {
  const f = await fixture([
    vector(50, 30, 0, 0),
    vector(53, 2, 0, 0),
    vector(53, 3, 0, 0),
    vector(54, 30, 0, 0),
    vector(52, 31, 0, 0),
    vector(53, 4, 0, 0),
  ]);
  const v = f.machine.vector;
  for (let lane = 0; lane < 8; lane++) {
    v.setLane(0, lane, 0xe834);
  }
  f.step(f.machine); // VRCPH prepares the high half for VRSQL.
  const state = f.machine.snapshot();
  f.machine.restore(state);
  f.step(f.machine);
  assert.equal(v.lane(2, 0), 0x5bc2); // Independent physical-console test value.
  assert.equal(v.dividerPending, false);
  f.step(f.machine);
  assert.equal(v.lane(3, 0), 0xc2ff);
  f.step(f.machine); // VRSQH prepares another high half.
  f.step(f.machine); // Standalone VRSQ discards that high half.
  assert.equal(v.dividerPending, false);
  f.step(f.machine);
  assert.equal(v.lane(4, 0), 0xc2ff);
});

test('RSP STV stores a register-group diagonal with element rotation and DMEM-window wrapping', async () => {
  const f = await fixture([0xe9085901]); // Actual SM64 STV v8[byte 2],16(r8).
  const v = f.machine.vector;
  for (let register = 0; register < 32; register++) {
    for (let byte = 0; byte < 16; byte++) {
      v.setByte(register, byte, register * 16 + byte);
    }
  }
  const before = v.snapshot();
  f.machine.set(8, 0x100);
  f.step(f.machine);
  assert.deepEqual(
    [...f.data.subarray(0x110, 0x120)],
    [
      0x90, 0x91, 0xa2, 0xa3, 0xb4, 0xb5, 0xc6, 0xc7, 0xd8, 0xd9, 0xea, 0xeb, 0xfc, 0xfd, 0x8e,
      0x8f,
    ],
  );
  f.machine.set(8, 0x123);
  f.machine.vectorMemory('STV', 15, 8, 0, 3); // Odd element and low VT bits are ignored.
  assert.deepEqual(
    [...f.data.subarray(0x120, 0x130)],
    [
      0xfd, 0x8e, 0x8f, 0x90, 0x91, 0xa2, 0xa3, 0xb4, 0xb5, 0xc6, 0xc7, 0xd8, 0xd9, 0xea, 0xeb,
      0xfc,
    ],
  );
  f.machine.set(8, 0xff8);
  f.machine.vectorMemory('STV', 8, 8, 0, 2);
  assert.deepEqual(
    [...f.data.subarray(0xff8), ...f.data.subarray(0, 8)],
    [
      0x90, 0x91, 0xa2, 0xa3, 0xb4, 0xb5, 0xc6, 0xc7, 0xd8, 0xd9, 0xea, 0xeb, 0xfc, 0xfd, 0x8e,
      0x8f,
    ],
  );
  assert.deepEqual(v.snapshot(), before);
});

test('RSP LTV distributes lanes across a register group and preserves every other byte', async () => {
  const f = await fixture([0]);
  for (let i = 0; i < 4096; i++) {
    f.data[i] = i & 255;
  }
  const v = f.machine.vector;
  for (let register = 0; register < 32; register++) {
    for (let byte = 0; byte < 16; byte++) {
      v.setByte(register, byte, 0xaa);
    }
  }
  f.machine.set(1, 0x129);
  f.machine.vectorMemory('LTV', 15, 1, 0, 3);
  const expected = [
    [9, 0, 0x33, 0x34],
    [10, 2, 0x35, 0x36],
    [11, 4, 0x37, 0x28],
    [12, 6, 0x29, 0x2a],
    [13, 8, 0x2b, 0x2c],
    [14, 10, 0x2d, 0x2e],
    [15, 12, 0x2f, 0x30],
    [8, 14, 0x31, 0x32],
  ];
  for (let register = 0; register < 32; register++) {
    const row = Array.from({ length: 16 }, () => 0xaa),
      item = expected.find((e) => e[0] === register);
    if (item) {
      row[item[1]!] = item[2]!;
      row[item[1]! + 1] = item[3]!;
    }
    assert.deepEqual(
      Array.from({ length: 16 }, (_, byte) => v.byte(register, byte)),
      row,
    );
  }
});

const immediate = (opcode: number, rs: number, rt: number, value: number) =>
  ((opcode << 26) | (rs << 21) | (rt << 16) | (value & 65535)) >>> 0;
const vector = (operation: number, vd: number, vs: number, vt: number, element = 0) =>
  ((18 << 26) | ((16 + element) << 21) | (vt << 16) | (vs << 11) | (vd << 6) | operation) >>> 0;
const vectorMemory = (
  store: boolean,
  operation: number,
  vt: number,
  base: number,
  element: number,
  offset: number,
) =>
  (((store ? 58 : 50) << 26) |
    (base << 21) |
    (vt << 16) |
    (operation << 11) |
    (element << 7) |
    (offset & 127)) >>>
  0;
async function fixture(words: number[], entry = 0) {
  const code = new DataView(new ArrayBuffer(4096)),
    data = new Uint8Array(4096);
  let broke = false;
  words.forEach((word, index) => code.setUint32((entry + index * 4) & 4095, word, false));
  const bus: RspBus = {
    instruction: (address) => code.getUint32(address, false),
    readByte: (address) => data[address]!,
    writeByte: (address, value) => {
      data[address] = value;
    },
    readControl: () => 0,
    writeControl: () => {},
    break: () => {
      broke = true;
    },
  };
  const machine = new RspMachine(bus);
  machine.enter(entry);
  const program = (await importStaticProgram<RspMachine>(
    liftRsp(words.map((word, index) => decodeRsp(word, (entry + index * 4) & 4095))),
  )) as RspProgram;
  return {
    machine,
    step: program.step,
    prepareLinear: program.prepareLinear!,
    runLocal: program.runLocal!,
    data,
    code,
    broke: () => broke,
  };
}

test('RSP spans preflight words and stop before control, branches and potentially trapping packed loads', async () => {
  const local = immediate(9, 1, 1, 1);
  for (const boundary of [0x40812000, 0x1000ffff, 13, vectorMemory(false, 6, 2, 1, 2, 0)]) {
    const f = await fixture([local, local, local, local, boundary]);
    const before = f.machine.snapshot();
    const block = f.prepareLinear(f.machine, 64)!;
    assert.equal(block.instructions, 4);
    assert.deepEqual(f.machine.snapshot(), before, 'preflight has no machine effects');
    block.execute();
    assert.equal(f.machine.pc, 16);
    assert.equal(f.machine.r(1), 4);
    assert.equal(f.prepareLinear(f.machine, 64), undefined);
  }
  const changed = await fixture([local, local, local, local, local]);
  changed.code.setUint32(8, 0xffffffff, false);
  const before = changed.machine.snapshot();
  assert.equal(changed.prepareLinear(changed.machine, 64), undefined);
  assert.deepEqual(changed.machine.snapshot(), before);
  changed.machine.nextPc = 100;
  assert.equal(changed.prepareLinear(changed.machine, 64), undefined);
});

test('compiler span candidates skip impossible starts and retain spans across IMEM wrapping', async () => {
  const local = immediate(9, 1, 1, 1);
  const short = await fixture([local, local, local, 13]);
  let probes = 0;
  const instruction = short.machine.bus.instruction;
  short.machine.bus.instruction = (address) => {
    probes++;
    return instruction(address);
  };
  assert.equal(short.prepareLinear(short.machine, 64), undefined);
  assert.equal(probes, 0, 'the compiler already knows there cannot be four local instructions');
  const wrapped = await fixture([local, local, local, local, 13], 0xff8);
  const block = wrapped.prepareLinear(wrapped.machine, 64)!;
  assert.equal(block.instructions, 4);
  block.execute();
  assert.equal(wrapped.machine.pc, 8);
  assert.equal(wrapped.machine.r(1), 4);
});

test('bounded RSP runs preserve every prefix across IMEM wrap and an untaken delay slot with one fetch per word', async () => {
  const words = Array.from(
    { length: 256 },
    (_, i) => [0x24210001, 0xac010100, 0x8c020100, 0x4a0208c0, 0x4a0208c8, 0][i % 6]!,
  );
  for (const entry of [0xf8, 0xff0]) {
    for (const count of [1, 4, 5, 16, 31, 63, 64, 65, 127, 255, 256]) {
      const reference = await fixture([0x14000004, ...words], entry),
        batched = await fixture([0x14000004, ...words], entry);
      for (const f of [reference, batched]) {
        f.machine.vector.registers.fill(0x8000, 8, 24);
        f.step(f.machine);
      }
      for (let i = 0; i < count; i++) {
        reference.step(reference.machine);
      }
      let fetches = 0;
      const instruction = batched.machine.bus.instruction;
      batched.machine.bus.instruction = (pc) => {
        fetches++;
        return instruction(pc);
      };
      assert.equal(batched.runLocal(batched.machine, count), count);
      assert.equal(fetches, count);
      assert.deepEqual(batched.machine.snapshot(), reference.machine.snapshot());
      assert.deepEqual(batched.data, reference.data);
    }
  }
});

test('bounded RSP runs follow taken loops, calls, returns and delay slots, then stop before BREAK', async () => {
  const words = [
    0x24010003, 0x2421ffff, 0x1c20fffe, 0x24420001, 0x0c000008, 0x24630001, 13, 0, 0x03e00008,
    0x24840001,
  ];
  for (const count of [1, 2, 3, 4, 5, 9, 11, 12, 13, 14, 64]) {
    const reference = await fixture(words),
      batched = await fixture(words);
    for (let i = 0; i < Math.min(count, 14); i++) {
      reference.step(reference.machine);
    }
    assert.equal(batched.runLocal(batched.machine, count), Math.min(count, 14));
    assert.deepEqual(batched.machine.snapshot(), reference.machine.snapshot());
    assert.equal(batched.broke(), false);
  }
});

test('bounded RSP runs stop before device controls, unsupported words and branches in delay slots', async () => {
  for (const boundary of [0x40012000, 0x40812000, 0xffffffff, vectorMemory(false, 6, 2, 1, 2, 0)]) {
    const f = await fixture([0x24210001, 0x24210001, 0x24210001, 0x24210001, 13]);
    f.code.setUint32(16, boundary, false);
    assert.equal(f.runLocal(f.machine, 64), 4);
    assert.equal(f.machine.r(1), 4);
    const before = f.machine.snapshot();
    assert.equal(f.runLocal(f.machine, 64), 0);
    assert.deepEqual(f.machine.snapshot(), before);
  }
  const f = await fixture([0x08000004, 0x08000004, 0, 0, 13]);
  assert.equal(f.runLocal(f.machine, 64), 1);
  assert.equal(f.machine.pc, 4);
  assert.equal(f.machine.nextPc, 16);
  assert.equal(f.machine.inBranchDelaySlot, true);
  assert.throws(() => f.step(f.machine), /outside this execution contract/);
});

test('bounded RSP runs require the system guarantee for stable device reads and exclude the semaphore', async () => {
  const f = await fixture([
    0x40012000, 0x40022800, 0x40033000, 0x40045000, 0x40055800, 0x40063800, 13,
  ]);
  const reads: number[] = [];
  f.machine.bus.readControl = (index) => {
    reads.push(index);
    return index * 100;
  };
  assert.equal(f.runLocal(f.machine, 64), 0);
  assert.deepEqual(reads, []);
  assert.equal(f.runLocal(f.machine, 64, true), 5);
  assert.deepEqual(reads, [4, 5, 6, 10, 11]);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((r) => f.machine.r(r)),
    [400, 500, 600, 1000, 1100],
  );
  assert.equal(f.machine.pc, 20);
  assert.equal(f.runLocal(f.machine, 64, true), 0);
  assert.deepEqual(reads, [4, 5, 6, 10, 11]);
  f.step(f.machine);
  assert.equal(reads.at(-1), 7);
});

test('bounded RSP runs check packed-memory alignment at the actual instruction boundary', async () => {
  for (const store of [false, true]) {
    for (const kind of [6, 7]) {
      const packed = vectorMemory(store, kind, 5, 1, 0, 0);
      const words = [0x24010100, packed, 0x24210001, packed, 13];
      const reference = await fixture(words),
        batched = await fixture(words);
      for (const f of [reference, batched]) {
        for (let i = 0; i < 4096; i++) {
          f.data[i] = i & 255;
        }
        f.machine.vector.registers.fill(0x7f00);
      }
      for (let i = 0; i < 3; i++) {
        reference.step(reference.machine);
      }
      assert.equal(batched.runLocal(batched.machine, 64), 3);
      assert.deepEqual(batched.machine.snapshot(), reference.machine.snapshot());
      assert.deepEqual(batched.data, reference.data);
      assert.throws(() => batched.step(batched.machine), /eight-byte-aligned DMEM address/);
    }
  }
});

test('bounded RSP runs select mutable microcode variants afresh', async () => {
  const f = await fixture(Array.from({ length: 8 }, () => 0x24210001));
  const program = (await importStaticProgram<RspMachine>(
    liftRsp([
      ...Array.from({ length: 8 }, (_, i) => decodeRsp(0x24210001, i * 4)),
      decodeRsp(0x24210003, 4),
      decodeRsp(0x24210005, 12),
    ]),
  )) as RspProgram;
  f.code.setUint32(4, 0x24210003, false);
  f.code.setUint32(12, 0x24210005, false);
  assert.equal(program.runLocal!(f.machine, 8), 8);
  assert.equal(f.machine.r(1), 14);
  assert.equal(f.machine.instructions, 8);
  f.machine.enter(0);
  f.code.setUint32(4, 0x24210001, false);
  assert.equal(program.runLocal!(f.machine, 8), 8);
  assert.equal(f.machine.r(1), 26);
});

test('cached RSP entries retain word-specific barriers across machines and unknown replacements', async () => {
  const local = 0x24420001,
    write = 0x40812000,
    a = await fixture([local, 13]),
    b = await fixture([local, 13]);
  const program = (await importStaticProgram<RspMachine>(
    liftRsp([decodeRsp(local, 0), decodeRsp(write, 0), decodeRsp(13, 4)]),
  )) as RspProgram;
  const writes: number[] = [];
  a.machine.bus.writeControl = (index) => {
    writes.push(index);
  };
  assert.equal(program.runLocal!(a.machine, 1), 1);
  a.machine.enter(0);
  a.code.setUint32(0, write, false);
  const stopped = a.machine.snapshot();
  assert.equal(program.runLocal!(a.machine, 1, true), 0);
  assert.deepEqual(a.machine.snapshot(), stopped);
  assert.deepEqual(writes, []);
  // The shared module last saw a barrier at this address. A different
  // machine's actual word must select its original local operation again.
  assert.equal(program.runLocal!(b.machine, 1), 1);
  assert.equal(b.machine.r(2), 1);
  program.step(a.machine);
  assert.deepEqual(writes, [4]);
  a.machine.enter(0);
  a.code.setUint32(0, 0xffffffff, false);
  const unknown = a.machine.snapshot();
  assert.equal(program.runLocal!(a.machine, 1), 0);
  assert.deepEqual(a.machine.snapshot(), unknown);
  assert.throws(() => program.step(a.machine), /not included in the static program/);
});

test('cached RSP entries reevaluate stable-read permission and packed alignment on each use', async () => {
  const status = 0x40022000,
    packed = vectorMemory(false, 6, 5, 1, 0, 0),
    f = await fixture([status, 13]);
  const program = (await importStaticProgram<RspMachine>(
    liftRsp([decodeRsp(status, 0), decodeRsp(packed, 0), decodeRsp(13, 4)]),
  )) as RspProgram;
  let reads = 0;
  f.machine.bus.readControl = () => ++reads;
  assert.equal(program.runLocal!(f.machine, 1, true), 1);
  f.machine.enter(0);
  assert.equal(program.runLocal!(f.machine, 1), 0);
  assert.equal(reads, 1, 'a cached entry does not retain a prior caller permission');
  f.code.setUint32(0, packed, false);
  f.machine.set(1, 0x100);
  assert.equal(program.runLocal!(f.machine, 1), 1);
  f.machine.enter(0);
  f.machine.set(1, 0x101);
  const stopped = f.machine.snapshot();
  assert.equal(program.runLocal!(f.machine, 1), 0);
  assert.deepEqual(f.machine.snapshot(), stopped);
});

test('RSP source labels distinguish IMEM offsets, SP controls, vector lanes and byte elements', () => {
  assert.equal(decodeRsp(0x09000419, 0).text, 'J IMEM+$064');
  assert.equal(decodeRsp(0x40012000, 0).text, 'MFC0 $1, SP_STATUS');
  assert.equal(decodeRsp(vector(0, 3, 1, 2, 14), 0).text, 'VMULF $v3, $v1, $v2[lane 6]');
  assert.equal(decodeRsp(vectorMemory(false, 3, 1, 0, 8, 1), 0).text, 'LDV $v1[byte 8], 8($0)');
  assert.equal(decodeRsp(vector(50, 27, 11, 29, 11), 0).text, 'VRCPH $v27[lane 3], $v29[lane 3]');
});

test('RSP scalar instructions wrap words, preserve zero and wrap unaligned DMEM accesses', async () => {
  const f = await fixture([
    immediate(8, 1, 2, 1),
    immediate(43, 3, 2, 0),
    immediate(35, 3, 4, 0),
    immediate(9, 0, 0, 123),
  ]);
  f.machine.set(1, 0x7fffffff);
  f.machine.set(3, 4095);
  f.step(f.machine);
  assert.equal(f.machine.r(2), -0x80000000);
  f.step(f.machine);
  assert.deepEqual([f.data[4095], f.data[0], f.data[1], f.data[2]], [128, 0, 0, 0]);
  f.step(f.machine);
  assert.equal(f.machine.r(4), -0x80000000);
  f.step(f.machine);
  assert.equal(f.machine.r(0), 0);
  assert.throws(() => decodeRsp(0x012a0018, 0), /not implemented/); // Scalar MULT is absent on RSP.
});

test('RSP branches execute their delay slot across IMEM wrap and BREAK retires', async () => {
  const f = await fixture([immediate(4, 0, 0, 1), immediate(9, 0, 1, 7), 13], 4092);
  f.step(f.machine);
  assert.equal(f.machine.pc, 0);
  f.step(f.machine);
  assert.equal(f.machine.r(1), 7);
  assert.equal(f.machine.pc, 4);
  f.step(f.machine);
  assert.equal(f.broke(), true);
  assert.equal(f.machine.instructions, 3);
  const changed = await fixture([0]);
  changed.code.setUint32(0, 13, false);
  assert.throws(() => changed.step(changed.machine), /not included/);
});

test('RSP vector multiply keeps 48-bit accumulation separate from saturated destinations', async () => {
  const f = await fixture([
    vector(0, 3, 1, 2),
    vector(8, 4, 1, 2),
    vector(29, 5, 0, 0, 8),
    vector(29, 6, 0, 0, 9),
    vector(29, 7, 0, 0, 10),
  ]);
  for (let lane = 0; lane < 8; lane++) {
    f.machine.vector.setLane(1, lane, 0x8000);
    f.machine.vector.setLane(2, lane, 0x8000);
  }
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(3, 0), 32767);
  assert.equal(f.machine.vector.accumulator[0], 0x80008000);
  f.machine.vector.accumulator[0] = 2 ** 47 - 1;
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(4, 0), 0x8000);
  assert.equal(f.machine.vector.accumulator[0], -0x7fff80000001);
  const accumulator = BigInt(f.machine.vector.accumulator[0]!);
  f.step(f.machine);
  f.step(f.machine);
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(5, 0), Number((accumulator >> 32n) & 65535n));
  assert.equal(f.machine.vector.lane(6, 0), Number((accumulator >> 16n) & 65535n));
  assert.equal(f.machine.vector.lane(7, 0), Number(accumulator & 65535n));
  assert.equal(f.machine.vector.accumulator[0], Number(accumulator));
});

test('RSP partial products distinguish signed operands and preserve low fractional results', async () => {
  const f = await fixture([vector(5, 3, 1, 2), vector(6, 4, 1, 2), vector(14, 5, 0, 0)]);
  f.machine.vector.setLane(1, 0, 0x8000);
  f.machine.vector.setLane(2, 0, 0xffff);
  f.step(f.machine);
  assert.equal(f.machine.vector.accumulator[0], -2147450880);
  assert.equal(f.machine.vector.lane(3, 0), 0x8000);
  f.step(f.machine);
  assert.equal(f.machine.vector.accumulator[0], -32768);
  assert.equal(f.machine.vector.lane(4, 0), 0x8000);
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(5, 0), 0x8000);
});

test('RSP vector broadcasts snapshot aliased inputs and add/subtract consume carry bits', async () => {
  const f = await fixture([vector(16, 1, 2, 1, 8), vector(21, 3, 4, 5), vector(17, 6, 4, 5)]);
  f.machine.vector.setLane(1, 0, 10);
  for (let lane = 0; lane < 8; lane++) {
    f.machine.vector.setLane(2, lane, lane + 1);
    f.machine.vector.accumulator[lane] = 0x123456780000;
  }
  f.step(f.machine);
  assert.deepEqual(
    [...f.machine.vector.registers.subarray(8, 16)],
    [11, 12, 13, 14, 15, 16, 17, 18],
  );
  assert.equal(f.machine.vector.accumulator[0], 0x12345678000b);
  f.machine.vector.setLane(4, 0, 1);
  f.machine.vector.setLane(5, 0, 2);
  f.machine.vector.setLane(4, 1, 3);
  f.machine.vector.setLane(5, 1, 2);
  f.step(f.machine);
  assert.equal(f.machine.vector.carry, 0x301);
  assert.equal(f.machine.vector.lane(3, 0), 65535);
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(6, 0), 65534);
  assert.equal(f.machine.vector.lane(6, 1), 1);
  assert.equal(f.machine.vector.carry, 0);
});

test('RSP comparisons consume tie flags and logical operations preserve high accumulator slices', async () => {
  const f = await fixture([vector(35, 3, 1, 2), vector(44, 4, 1, 2)]);
  f.machine.vector.carry = 0x202;
  f.step(f.machine);
  assert.equal(f.machine.vector.compare, 0xfd);
  assert.equal(f.machine.vector.carry, 0);
  f.machine.vector.accumulator[0] = 0x12345678abcd;
  f.machine.vector.setLane(1, 0, 0x12f0);
  f.machine.vector.setLane(2, 0, 0x100f);
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(4, 0), 0x02ff);
  assert.equal(f.machine.vector.accumulator[0], 0x1234567802ff);
});

test('RSP clipping retains sign, equality and minus-one boundaries for the low-half comparison', async () => {
  const f = await fixture([vector(37, 3, 1, 2), vector(36, 4, 1, 2), vector(38, 5, 1, 2)]);
  const v = f.machine.vector;
  const left = [-5, -4, -3, 3, 4, 5, -32768, 0],
    right = [4, 4, 4, 4, 4, -4, -32768, -32768];
  for (let lane = 0; lane < 8; lane++) {
    v.setLane(1, lane, left[lane]!);
    v.setLane(2, lane, right[lane]!);
    v.accumulator[lane] = 0x123456780000;
  }
  f.step(f.machine);
  assert.deepEqual([...v.registers.subarray(24, 32)], [65532, 65532, 65533, 3, 4, 5, 32768, 32768]);
  assert.equal(v.carry, 0xaca7);
  assert.equal(v.compare, 0xf0c3);
  assert.equal(v.extension, 1); // -5 + 4 = -1: VCL must still resolve the low half.
  assert.equal(v.accumulator[0], 0x12345678fffc);

  const lowerLeft = [0x8000, 0x8000, 7, 9, 0xffff, 0, 0, 9],
    lowerRight = [0x8000, 0x8000, 9, 7, 1, 0, 1, 2];
  for (let lane = 0; lane < 8; lane++) {
    v.setLane(1, lane, lowerLeft[lane]!);
    v.setLane(2, lane, lowerRight[lane]!);
  }
  f.step(f.machine);
  assert.deepEqual([...v.registers.subarray(32, 40)], [32768, 32768, 7, 9, 1, 0, 0, 65534]);
  assert.equal(v.compare, 0xb0c1); // Equal low sums differ according to VCE; definite high tests survive.
  assert.equal(v.carry, 0);
  assert.equal(v.extension, 0);
  assert.equal(v.accumulator[4], 0x123456780001);

  for (let lane = 0; lane < 8; lane++) {
    v.setLane(1, lane, left[lane]!);
    v.setLane(2, lane, right[lane]!);
  }
  v.carry = v.extension = 255;
  f.step(f.machine);
  assert.deepEqual([...v.registers.subarray(40, 48)], [65531, 65532, 65533, 3, 4, 5, 32768, 32767]);
  assert.equal(v.compare, 0xf0c1);
  assert.equal(v.carry, 0);
  assert.equal(v.extension, 0);
});

test('paired RSP VCH/VCL clip flags agree with signed 32-bit bounds at fractional boundaries', async () => {
  const f = await fixture([vector(37, 3, 1, 2), vector(36, 4, 5, 6)]);
  const values = [
    -2147483648, -2147483647, -65537, -65536, -65535, -1, 0, 1, 65535, 65536, 65537, 2147483647,
  ];
  for (const a of values) {
    for (const b of values) {
      f.machine.enter(0);
      const v = f.machine.vector;
      v.setLane(1, 0, a >>> 16);
      v.setLane(2, 0, b >>> 16);
      v.setLane(5, 0, a);
      v.setLane(6, 0, b);
      f.step(f.machine);
      f.step(f.machine);
      // For same-sign zero operands VCH stores VT's sign in VCC_LO; the
      // redundant -0 comparison is omitted by the hardware's clip encoding.
      const le = a === 0 && b === 0 ? false : BigInt(a) <= -BigInt(b);
      assert.equal(v.compare & 1, Number(le), `${a} <= -(${b})`);
      assert.equal((v.compare >>> 8) & 1, Number(a >= b), `${a} >= ${b}`);
    }
  }
});

test('RSP reciprocal reproduces ROM significands, exponents and negative boundary quirks', () => {
  const cases = [
    [0, 0x7fffffff],
    [1, 0x7fffc000],
    [2, 0x3fffe000],
    [3, 0x2aaaa000],
    [4096, 0x0007fffc],
    [4104, 0x0007fc00],
    [4112, 0x0007f804],
    [32767, 0x00010040],
    [32768, 0x0000ffff],
    [65536, 0x00007fff],
    [-1, 0x80003fff],
    [-32767, 0xfffeffbf],
    [-32768, 0xffff0000],
    [-32769, 0xffff0000],
    [-65536, 0xffff7fdf],
    [-2147483648, 0xfffffffe],
  ];
  for (const [input, expected] of cases) {
    assert.equal(rspReciprocal(input!), expected, String(input));
  }
});

test('RSP reciprocal pairs retain input/output latches across a checkpoint and write just one lane', async () => {
  const words = [
    vector(48, 3, 0, 2, 9),
    vector(50, 3, 1, 2, 10),
    vector(49, 3, 2, 2, 11),
    vector(50, 3, 3, 2, 8),
    vector(49, 3, 4, 2, 9),
  ];
  const f = await fixture(words),
    restored = await fixture(words),
    v = f.machine.vector;
  v.setLane(2, 0, 0);
  v.setLane(2, 1, 1);
  v.setLane(2, 2, 1); // Upper half of 0x00010000.
  v.setLane(2, 3, 0);
  v.carry = 0x1234;
  v.compare = 0xabcd;
  v.extension = 0x56;
  v.accumulator.fill(0x123456780000);
  v.registers.fill(0xaaaa, 24, 32);
  f.step(f.machine); // 16-bit reciprocal(1).
  assert.equal(v.lane(3, 0), 0xc000);
  assert.equal(v.dividerOutput, 0x7fffc000);
  f.step(f.machine); // Return old high half, latch new input high half.
  assert.equal(v.lane(3, 1), 0x7fff);
  assert.equal(v.dividerPending, true);
  restored.machine.restore(f.machine.snapshot());
  for (const item of [f, restored]) {
    item.step(item.machine);
    item.step(item.machine);
    item.step(item.machine);
  }
  assert.deepEqual(restored.machine.snapshot(), f.machine.snapshot());
  assert.deepEqual(
    [...v.registers.subarray(24, 32)],
    [0xc000, 0x7fff, 0x7fff, 0, 0xc000, 0xaaaa, 0xaaaa, 0xaaaa],
  );
  assert.equal(v.accumulator[7], 0x123456780001);
  assert.deepEqual([v.carry, v.compare, v.extension], [0x1234, 0xabcd, 0x56]);
  assert.equal(v.dividerPending, false);
});

test('RSP VMOV selects aliased source lanes before writing and preserves divider/flag state', async () => {
  const f = await fixture([
    vector(51, 2, 5, 2, 4),
    vector(50, 2, 1, 2, 9),
    vector(48, 2, 2, 2, 8),
    vector(49, 2, 3, 2, 9),
  ]);
  const v = f.machine.vector;
  for (let lane = 0; lane < 8; lane++) {
    v.setLane(2, lane, lane + 1);
  }
  v.dividerInput = 0x1234;
  v.dividerOutput = 0xabcdef01;
  v.dividerPending = true;
  f.step(f.machine);
  assert.equal(v.lane(2, 5), 5);
  assert.deepEqual([v.dividerInput, v.dividerOutput, v.dividerPending], [0x1234, 0xabcdef01, true]);
  f.step(f.machine);
  assert.equal(v.lane(2, 1), 0xabcd);
  assert.equal(v.dividerInput, 2); // Reads the old aliased lane before writing its high result.
  f.step(f.machine);
  assert.equal(v.dividerPending, false); // A standalone VRCP cancels a pending high input.
  f.step(f.machine);
  assert.equal(v.dividerOutput, rspReciprocal(-21555)); // Sign-extended old VT[1] = 0xABCD.
});

test('RSP checkpoints preserve a pending branch, vector flags and signed accumulator bits', async () => {
  const words = [immediate(4, 0, 0, 2), immediate(9, 0, 1, 7), immediate(9, 0, 1, 99), 13];
  const original = await fixture(words),
    restored = await fixture(words);
  original.machine.vector.setLane(3, 2, 0xfedc);
  original.machine.vector.accumulator[2] = -0x123456789ab;
  original.machine.vector.carry = 0xabcd;
  original.machine.vector.compare = 0x1234;
  original.machine.vector.extension = 0x89;
  original.step(original.machine);
  const state = original.machine.snapshot();
  restored.machine.restore(state);
  state.vector.registers[26] = 0;
  for (const item of [original, restored]) {
    item.step(item.machine);
    item.step(item.machine);
  }
  assert.equal(restored.machine.r(1), 7);
  assert.deepEqual(restored.machine.snapshot(), original.machine.snapshot());
});

test('vector quad/rest loads rebuild an unaligned vector while byte elements retain their meaning', async () => {
  const f = await fixture([
    vectorMemory(false, 4, 1, 1, 0, 0),
    vectorMemory(false, 5, 1, 1, 0, 1),
    vectorMemory(true, 3, 1, 2, 8, 0),
    vectorMemory(false, 1, 2, 0, 2, 0),
  ]);
  f.data.set(Array.from({ length: 64 }, (_, i) => i));
  f.machine.set(1, 3);
  f.machine.set(2, 0xffc);
  f.step(f.machine);
  f.step(f.machine);
  assert.deepEqual(
    Array.from({ length: 16 }, (_, i) => f.machine.vector.byte(1, i)),
    Array.from({ length: 16 }, (_, i) => i + 3),
  );
  f.step(f.machine);
  assert.deepEqual([...f.data.subarray(0xffc)], [11, 12, 13, 14]);
  assert.deepEqual([...f.data.subarray(0, 4)], [15, 16, 17, 18]);
  f.step(f.machine);
  assert.equal(f.machine.vector.lane(2, 1), 0x0f10);
  assert.equal(decodeRsp(vectorMemory(false, 3, 1, 0, 0, -1), 0).signedImmediate, -8);
});

test('RSP aligned packed vertex loads distinguish unsigned fixed-point colors from signed bytes', async () => {
  const f = await fixture([
    vectorMemory(false, 7, 1, 2, 0, 0),
    vectorMemory(false, 6, 3, 2, 0, 0),
    vectorMemory(true, 7, 1, 4, 0, 0),
    vectorMemory(true, 6, 3, 4, 0, 1),
  ]);
  f.machine.set(2, 0xff8);
  f.machine.set(4, 0x200);
  f.data.set([0, 1, 127, 128, 254, 255, 64, 192], 0xff8);
  f.step(f.machine);
  f.step(f.machine);
  assert.deepEqual(
    [...f.machine.vector.registers.subarray(8, 16)],
    [0, 128, 16256, 16384, 32512, 32640, 8192, 24576],
  );
  assert.deepEqual(
    [...f.machine.vector.registers.subarray(24, 32)],
    [0, 256, 32512, 32768, 65024, 65280, 16384, 49152],
  );
  assert.throws(() => f.machine.vectorMemory('LUV', 1, 2, 1, 0), /eight-byte-aligned/);
  assert.throws(() => f.machine.vectorMemory('LUV', 1, 2, 0, 2), /byte element zero/);
  f.step(f.machine);
  f.step(f.machine);
  assert.deepEqual(
    [...f.data.subarray(0x200, 0x210)],
    [0, 1, 127, 128, 254, 255, 64, 192, 0, 1, 127, 128, 254, 255, 64, 192],
  );
});

test('compiled DMEM halfword transfers match byte-wise partial vectors, elements and bank wrapping', () => {
  const referenceBytes = new Uint8Array(4096),
    candidateBytes = new Uint8Array(4096);
  const make = (bytes: Uint8Array, direct: boolean) =>
    new RspMachine({
      ...(direct ? { data: new DataView(bytes.buffer) } : {}),
      instruction: () => 0,
      readByte: (a) => bytes[a]!,
      writeByte: (a, v) => {
        bytes[a] = v;
      },
      readControl: () => 0,
      writeControl: () => {},
      break: () => {},
    });
  const reference = make(referenceBytes, false),
    candidate = make(candidateBytes, true);
  for (const store of [false, true]) {
    for (const [kind, size] of [
      ['BV', 1],
      ['SV', 2],
      ['LV', 4],
      ['DV', 8],
      ['QV', 0],
      ['RV', -1],
    ] as const) {
      for (let alignment = 0; alignment < 16; alignment++) {
        for (let element = 0; element < 16; element++) {
          for (const page of [0x80, 0xff0]) {
            const operation = (store ? 'S' : 'L') + kind;
            reference.set(1, page + alignment);
            candidate.set(1, page + alignment);
            for (let i = 0; i < 4096; i++) {
              referenceBytes[i] = (i * 71 + alignment) & 255;
            }
            candidateBytes.set(referenceBytes);
            for (let i = 0; i < 256; i++) {
              reference.vector.registers[i] = (i * 3571 + 0x8000) & 65535;
            }
            candidate.vector.registers.set(reference.vector.registers);
            if (size < 0 && element) {
              assert.throws(
                () => reference.vectorMemory(operation, 3, 1, 0, element),
                /Nonzero LRV/,
              );
              assert.throws(
                () => candidate.transferVector(operation, store, 3, 1, 0, element, size),
                /Nonzero LRV/,
              );
            } else {
              reference.vectorMemory(operation, 3, 1, 0, element);
              candidate.transferVector(operation, store, 3, 1, 0, element, size);
            }
            assert.deepEqual(
              candidate.vector.snapshot(),
              reference.vector.snapshot(),
              `${operation} element ${element}, address ${page + alignment}`,
            );
            assert.deepEqual(candidateBytes, referenceBytes);
          }
        }
      }
    }
  }
  // A bus with observable byte callbacks keeps the original callback sequence.
  let reads = 0;
  reference.bus.readByte = (a) => {
    reads++;
    return referenceBytes[a]!;
  };
  reference.set(1, 0x100);
  reference.transferVector('LQV', false, 3, 1, 0, 0, 0);
  assert.equal(reads, 16);
});

test('guarded RSP control waits retain every bounded prefix, branch direction and zero register', async () => {
  const instructions = [];
  for (const control of [4, 5, 6, 10, 11]) {
    for (const destination of [0, 11]) {
      instructions.push(decodeRsp(((16 << 26) | (destination << 16) | (control << 11)) >>> 0, 0));
    }
  }
  for (const opcode of [4, 5]) {
    for (const destination of [0, 11]) {
      instructions.push(decodeRsp(((opcode << 26) | (destination << 21) | 0xfffe) >>> 0, 4));
    }
  }
  instructions.push(decodeRsp(0, 8), decodeRsp(13, 12));
  const program = (await importStaticProgram<RspMachine>(liftRsp(instructions))) as RspProgram;
  const reference = await fixture([0, 0, 0, 13]),
    candidate = await fixture([0, 0, 0, 13]);
  let coalesced = 0;
  for (const control of [4, 5, 6, 10, 11]) {
    for (const destination of [0, 11]) {
      for (const opcode of [4, 5]) {
        for (const value of [0, 1, 0x80000000]) {
          const word = ((16 << 26) | (destination << 16) | (control << 11)) >>> 0,
            branch = ((opcode << 26) | (destination << 21) | 0xfffe) >>> 0,
            taken = ((destination ? value : 0) === 0) === (opcode === 4);
          for (const f of [reference, candidate]) {
            f.code.setUint32(0, word, false);
            f.code.setUint32(4, branch, false);
            f.machine.bus.readControl = () => value;
          }
          for (let limit = 1; limit <= 256; limit++) {
            reference.machine.enter(0);
            candidate.machine.restore(reference.machine.snapshot());
            const count = taken ? limit : Math.min(limit, 3);
            for (let i = 0; i < count; i++) {
              program.step(reference.machine);
            }
            assert.equal(program.runLocal!(candidate.machine, limit, true, true), count);
            assert.deepEqual(
              candidate.machine.snapshot(),
              reference.machine.snapshot(),
              `control ${control}, destination ${destination}, branch ${opcode}, value ${value}, limit ${limit}`,
            );
          }
          coalesced += candidate.machine.executionStats.controlWaitInstructions;
        }
      }
    }
  }
  assert.ok(coalesced > 10000);
  candidate.machine.enter(0);
  candidate.code.setUint32(4, 0xffffffff, false);
  assert.equal(program.runLocal!(candidate.machine, 255, true, true), 1);
  assert.equal(
    candidate.machine.pc,
    4,
    'changed future words stop ordinary execution at their boundary',
  );
  candidate.machine.enter(0);
  assert.equal(
    program.runLocal!(candidate.machine, 255, false, true),
    0,
    'device stability is required',
  );
});
