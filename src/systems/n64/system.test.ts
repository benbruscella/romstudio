import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N64Memory } from './memory.js';
import { N64System } from './system.js';
import { N64Interrupts } from './interrupts.js';
import { N64Serial } from './serial.js';
import { N64Audio } from './audio.js';
import { decodeVr4300, liftVr4300, liftVr4300Pages } from '../../transpiler/vr4300.js';
import { N64Recovery } from '../../transpiler/n64-recovery.js';
import { importStaticProgram } from '../../transpiler/program.js';
import type { Vr4300Machine } from '../../runtime/vr4300.js';
import { decodeRsp, liftRsp } from '../../transpiler/rsp.js';
import type { RspMachine, RspProgram } from '../../runtime/rsp.js';

test('fast RAM words retain bus byte order, aliases, shared views and non-RAM guards', () => {
  const m = new N64Memory(Uint8Array.from([1, 2, 3, 4]));
  m.ram.bytes.set([0x12, 0x34, 0x56, 0x78]);
  for (const address of [0, 0x80000000, 0xa0000000]) {
    assert.equal(m.read32(address), 0x12345678);
  }
  m.write32(0xa0000000, 0x89abcdef);
  assert.equal(m.ram.read32(0), 0x89abcdef);
  m.ram.write32(4, 0x12345678);
  assert.equal(m.read64(0x80000000), 0x89abcdef12345678n);
  m.write32(0x803ffffc, 0xdeadbeef);
  assert.equal(m.ram.read32(0x3ffffc), 0xdeadbeef);
  m.signal.view.setUint32(0x1000, 0x11223344, false);
  assert.equal(m.read32(0xa4001000), 0x11223344);
  assert.equal(m.read32(0xb0000000), 0x01020304);
  assert.throws(() => m.write32(0xb0000000, 0), /read-only/);
  assert.throws(() => m.read32(0x803ffffd), /Unaligned/);
  assert.throws(() => m.read32(0x400000), /not implemented/);
});

test('idle candidate inspection rejects ordinary and invalid fetches without a virtual bus read', () => {
  const system = new N64System(new Uint8Array(0), 0x80000000);
  system.memory.ram.write32(0, 0x24420001); // ADDIU $v0,$v0,1 is ordinary game code.
  let reads = 0;
  const read = system.cpu.bus.read32.bind(system.cpu.bus);
  system.cpu.bus.read32 = (address) => {
    reads++;
    return read(address);
  };
  for (const pc of [0x80000000, 0x80000002, 0x803ffffc, 0xa4001000, 0xc0000000]) {
    system.cpu.pc = pc;
    system.cpu.nextPc = (pc + 4) >>> 0;
    const before = system.snapshot();
    assert.equal(system.advanceIdle(), 0);
    assert.deepEqual(system.snapshot(), before);
  }
  assert.equal(reads, 0);
});

test('unaligned CPU fetch faults are delivered by ordinary execution after idle rejection', () => {
  const system = new N64System(new Uint8Array(0), 0x80000002);
  system.cpu.control.write(12, 0);
  assert.equal(system.advanceIdle(), 0);
  assert.equal(system.synchronousExceptions, 0);
  system.step((cpu) => {
    cpu.bus.read32(cpu.pc);
  });
  assert.equal(system.synchronousExceptions, 1);
  assert.equal(system.cpu.pc, 0x80000180);
  assert.equal(system.cpu.control.read(8), 0x80000002);
  assert.equal((system.cpu.control.read(13) >>> 2) & 31, 4);
  assert.equal(system.ticks, 1);
});

test('matching RDRAM words still require valid permissions and branch-delay state', () => {
  const system = new N64System(new Uint8Array(0), 0xa0000000);
  system.memory.ram.write32(0, 0x1000ffff);
  system.memory.ram.write32(4, 0);
  system.cpu.control.write(12, 0x10); // User mode cannot execute a kernel alias.
  assert.equal(system.advanceIdle(4), 0);
  system.cpu.control.write(12, 0);
  system.cpu.nextPc = 0xa0000008;
  assert.equal(system.advanceIdle(4), 0);
  system.cpu.nextPc = 0xa0000004;
  assert.equal(system.advanceIdle(4), 4);
  system.memory.ram.write32(4, 0x24420001);
  assert.equal(system.advanceIdle(4), 0);
});

test('static instruction and page dispatch deliver fetch faults like original recovery', async () => {
  for (const lift of [liftVr4300, liftVr4300Pages]) {
    const program = await importStaticProgram<Vr4300Machine>(
      lift([decodeVr4300(0x24420001, 0x80000000)]),
    );
    for (const pc of [0x80000002, 0x80002002]) {
      const recovery = new N64Recovery();
      const original = new N64System(new Uint8Array(0), pc),
        replay = new N64System(new Uint8Array(0), pc);
      for (const s of [original, replay]) {
        s.cpu.control.write(12, 0);
      }
      assert.equal(replay.advanceIdle(), 0);
      original.step(recovery.stepCpu);
      replay.step(program.step);
      assert.equal(replay.synchronousExceptions, 1);
      assert.equal(replay.cpu.control.read(8), pc);
      assert.deepEqual(replay.snapshot(), original.snapshot());
    }
  }
});

test('original and static CPU execution use one instruction fetch before retiring', async () => {
  const instruction = decodeVr4300(0x24010001, 0x80000000);
  const operations = [
    new N64Recovery().stepCpu,
    (await importStaticProgram<Vr4300Machine>(liftVr4300([instruction]))).step,
    (await importStaticProgram<Vr4300Machine>(liftVr4300Pages([instruction]))).step,
  ];
  for (const step of operations) {
    const s = new N64System(new Uint8Array(0), 0x80000000);
    const read = s.memory.read32.bind(s.memory);
    let fetches = 0;
    s.memory.read32 = (address) => {
      if (address === 0) {
        fetches++;
        return fetches === 1 ? instruction.word : 0;
      }
      return read(address);
    };
    s.step(step);
    assert.equal(fetches, 1, 'a second bus read could return a different instruction word');
    assert.equal(s.cpu.r32(1), 1);
    assert.equal(s.cpu.instructions, 1);
    assert.equal(s.ticks, 1);
  }
});

test('idle coalescing reuses its freshly inspected RDRAM words and sees later writes', () => {
  const s = new N64System(new Uint8Array(0), 0x80000000);
  s.memory.ram.write32(0, 0x1000ffff);
  s.memory.ram.write32(4, 0);
  s.cpu.bus.read32 = () => {
    throw new Error('The inspected words must not be fetched again.');
  };
  assert.equal(s.advanceIdle(12), 12);
  s.memory.ram.write32(4, 0x24420001);
  assert.equal(s.advanceIdle(12), 0);
});

test('RSP spans and branch runs preserve clocks, DMA, PCM and interrupts against single ticks', async () => {
  const cpu = await importStaticProgram<Vr4300Machine>(
    liftVr4300([
      decodeVr4300(0x1000ffff, 0x80000000),
      decodeVr4300(0, 0x80000004),
      decodeVr4300(0x1000ffff, 0x80000180),
      decodeVr4300(0, 0x80000184),
    ]),
  );
  const straight = Array.from(
    { length: 64 },
    (_, i) => [0x24210001, 0xac010100, 0x8c040100, 0x4a0208c0, 0x4a0208c8, 0][i % 6]!,
  );
  straight.push(13); // BREAK is always executed separately.
  const branches = [
    0x24010005, 0x2421ffff, 0xac010100, 0x4a0208c0, 0x400b3000, 0x400c2000, 0x400d5000, 0x400e5800,
    0x1c20fff8, 0x24420001, 0x1000fff5, 0,
  ];
  const multiply = Array.from(
    { length: 64 },
    (_, i) =>
      ((18 << 26) |
        (24 << 21) |
        (31 << 16) |
        ((i & 3) << 11) |
        (((i + 1) & 3) << 6) |
        [7, 15, 14, 0, 8, 4, 13, 12][i & 7]!) >>>
      0,
  );
  const replacement = [(multiply[8]! & ~63) | 4, (multiply[9]! & ~63) | 14];
  multiply.push(13);
  for (const [words, local] of [
    [straight, false],
    [branches, true],
    [multiply, true],
  ] as const) {
    const rsp = (await importStaticProgram<RspMachine>(
      liftRsp([
        ...words.map((word, i) => decodeRsp(word, i * 4)),
        ...(words === multiply ? replacement.map((word, i) => decodeRsp(word, 32 + i * 4)) : []),
      ]),
    )) as RspProgram;
    for (const phase of [0, 1, 2]) {
      for (const compare of [7, 53, 999]) {
        const systems = [
          new N64System(new Uint8Array(32), 0x80000000),
          new N64System(new Uint8Array(32), 0x80000000, 0, true),
        ];
        const samples: number[][][] = [[], []];
        for (const [index, s] of systems.entries()) {
          const m = s.memory;
          for (const address of [0, 0x180]) {
            m.ram.write32(address, 0x1000ffff);
            m.ram.write32(address + 4, 0);
          }
          s.cpu.control.write(12, 0x8401);
          s.cpu.control.write(11, compare);
          words.forEach((word, i) => m.signal.view.setUint32(0x1000 + i * 4, word, false));
          s.rsp.vector.registers.fill(0x8000, 8, 24);
          if (words === multiply) {
            for (let lane = 0; lane < 256; lane++) {
              s.rsp.vector.registers[lane] = (lane * 3571 + 32768) & 65535;
            }
          }
          s.enableRsp(
            rsp.step,
            index && !local ? rsp.prepareLinear : undefined,
            index && local ? rsp.runLocal : undefined,
          );
          m.write32(0x04040010, 1);
          m.ram.write64(0x400, 0x123456787fff8000n);
          m.write32(0x04500000, 0x400);
          m.write32(0x04500010, 0);
          m.write32(0x04500008, 1);
          m.write32(0x04500004, 8);
          m.audio.output = (l, r) => samples[index]!.push([l, r]);
          m.signal.view.setUint32(0x100, 0xaabbccdd, false);
          m.write32(0x04040000, 0x100);
          m.write32(0x04040004, 0x300);
          m.write32(0x0404000c, 7);
          if (words === multiply) {
            m.ram.write32(0x500, replacement[0]!);
            m.ram.write32(0x504, replacement[1]!);
            m.write32(0x04040000, 0x1020);
            m.write32(0x04040004, 0x500);
            m.write32(0x04040008, 7);
          }
          m.video.write(0x1c, 5);
          m.video.write(0x18, 20);
          m.video.write(0x0c, 13);
          const state = s.snapshot();
          state.signalPhase = phase;
          s.restore(state);
        }
        const [reference, fast] = systems as [N64System, N64System];
        while (reference.ticks < 500) {
          reference.step(cpu.step);
        }
        let blocks = 0;
        while (fast.ticks < 500) {
          const before = fast.rsp.instructions;
          if (!fast.advanceIdle(500 - fast.ticks)) {
            fast.step(cpu.step);
          }
          if (fast.rsp.instructions - before > 1) {
            blocks++;
          }
        }
        if (local) {
          assert.ok(fast.executionStats.rspRunInstructions > 0);
        }
        assert.ok(blocks > 0, `phase ${phase}, Compare ${compare}`);
        assert.deepEqual(fast.snapshot(), reference.snapshot());
        assert.deepEqual(fast.memory.ram.bytes, reference.memory.ram.bytes);
        assert.deepEqual(fast.memory.signal.memory, reference.memory.signal.memory);
        assert.deepEqual(samples[1], samples[0]);
      }
    }
  }
});

test('coalescing a guarded idle loop preserves DMA, PCM, VI, Count/Compare and RSP event timing', async () => {
  const cpu = await importStaticProgram<Vr4300Machine>(
    liftVr4300([decodeVr4300(0x1000ffff, 0x80000000), decodeVr4300(0, 0x80000004)]),
  );
  const rsp = await importStaticProgram<RspMachine>(
    liftRsp([decodeRsp(0x1000ffff, 0), decodeRsp(0, 4)]),
  );
  for (const active of [false, true]) {
    const systems = [
      new N64System(
        Uint8Array.from({ length: 32 }, (_, i) => i),
        0x80000000,
      ),
      new N64System(
        Uint8Array.from({ length: 32 }, (_, i) => i),
        0x80000000,
      ),
    ];
    const samples = [[], []] as number[][][];
    for (const [which, system] of systems.entries()) {
      const m = system.memory;
      m.ram.write32(0, 0x1000ffff);
      m.ram.write32(4, 0);
      system.cpu.control.write(11, 999);
      m.write32(0x04600000, 0x300);
      m.write32(0x04600004, 0x10000000);
      m.write32(0x0460000c, 15);
      m.ram.bytes.set([1, 3, 0, 0, 0, 0, 0xfe], 0x200);
      m.ram.bytes[0x23f] = 1;
      m.write32(0x04800000, 0x200);
      m.write32(0x04800010, 0x1fc007c0);
      m.ram.write64(0x100, 0x123456787fff8000n);
      m.write32(0x04500000, 0x100);
      m.write32(0x04500010, 0);
      m.write32(0x04500008, 1);
      m.write32(0x04500004, 8);
      m.audio.output = (l, r) => samples[which]!.push([l, r]);
      m.video.write(0x1c, 5);
      m.video.write(0x18, 20);
      m.video.write(0x0c, 13);
      if (active) {
        m.signal.view.setUint32(0x1000, 0x1000ffff, false);
        m.signal.view.setUint32(0x1004, 0, false);
        system.enableRsp(rsp.step);
        m.write32(0x04040010, 1);
      }
    }
    const [native, fast] = systems as [N64System, N64System];
    while (native.ticks < 5000) {
      native.step(cpu.step);
    }
    let batches = 0;
    while (fast.ticks < 5000) {
      const ticks = fast.advanceIdle(5000 - fast.ticks);
      if (!ticks) {
        fast.step(cpu.step);
      } else {
        batches++;
      }
    }
    assert.ok(batches < 5000);
    assert.equal(fast.cpu.instructions, 5000);
    assert.deepEqual(fast.snapshot(), native.snapshot());
    assert.deepEqual(fast.memory.ram.bytes, native.memory.ram.bytes);
    assert.deepEqual(samples[1], samples[0]);
  }
});

test('idle coalescing rejects changed words and stops exactly at an accepted timer interrupt', async () => {
  const system = new N64System(new Uint8Array(0), 0x80000000),
    m = system.memory;
  m.ram.write32(0, 0x1000ffff);
  m.ram.write32(4, 0x24010001);
  assert.equal(system.advanceIdle(), 0);
  assert.equal(system.ticks, 0);
  m.ram.write32(4, 0);
  system.cpu.control.write(12, 0x8001);
  system.cpu.control.write(11, 4);
  assert.equal(system.advanceIdle(100), 8);
  assert.equal(system.cpu.control.read(9), 4);
  assert.equal(system.advanceIdle(), 0);
  assert.equal(system.ticks, 8);
  const cpu = await importStaticProgram<Vr4300Machine>(liftVr4300([decodeVr4300(0, 0x80000180)]));
  system.step(cpu.step);
  assert.equal(system.interruptEntries, 1);
  assert.equal(system.cpu.control.read(14), 0x80000000);
  assert.equal(system.cpu.instructions, 9);
});

test('a bounded RSP run stops before a gap and preserves the ordinary pending-tick continuation', async () => {
  const cpu = await importStaticProgram<Vr4300Machine>(
    liftVr4300([decodeVr4300(0x1000ffff, 0x80000000), decodeVr4300(0, 0x80000004)]),
  );
  const words = [...Array.from({ length: 9 }, () => 0x24420001), 13];
  const rsp = (await importStaticProgram<RspMachine>(
    liftRsp(words.map((word, i) => decodeRsp(word, i * 4))),
  )) as RspProgram;
  const systems = [
    new N64System(new Uint8Array(0), 0x80000000),
    new N64System(new Uint8Array(0), 0x80000000),
  ];
  for (const [index, s] of systems.entries()) {
    s.memory.ram.write32(0, 0x1000ffff);
    s.memory.ram.write32(4, 0);
    words.forEach((word, i) => s.memory.signal.view.setUint32(0x1000 + i * 4, word, false));
    s.memory.signal.view.setUint32(0x1020, 0xffffffff, false);
    s.enableRsp(rsp.step, undefined, index ? rsp.runLocal : undefined);
    s.memory.write32(0x04040010, 1);
    assert.throws(() => {
      while (s.ticks < 100) {
        if (!index || !s.advanceIdle(100 - s.ticks)) {
          s.step(cpu.step);
        }
      }
    }, /not included in the static program/);
    assert.equal(s.snapshot().pendingSignalInstruction, true);
  }
  const [reference, fast] = systems as [N64System, N64System];
  assert.deepEqual(fast.snapshot(), reference.snapshot());
  assert.ok(fast.executionStats.rspRunInstructions > 0);
  for (const s of systems) {
    s.memory.signal.view.setUint32(0x1020, 0x24420001, false);
    const retired = s.cpu.instructions;
    s.step(cpu.step);
    assert.equal(s.cpu.instructions, retired);
  }
  assert.deepEqual(fast.snapshot(), reference.snapshot());
});

test('an RSP debugger stop resumes its pending clock tick without retiring the CPU twice', async () => {
  const systems = Array.from({ length: 3 }, () => new N64System(new Uint8Array(0), 0x80000000));
  const words = [0x24210001, 0x24210001];
  const cpu = await importStaticProgram<Vr4300Machine>(
    liftVr4300(words.map((word, i) => decodeVr4300(word, 0x80000000 + i * 4))),
  );
  const rsp = await importStaticProgram<RspMachine>(
    liftRsp([decodeRsp(0x24420001, 0), decodeRsp(13, 4)]),
  );
  for (const system of systems) {
    words.forEach((word, i) => system.memory.ram.write32(i * 4, word));
    system.memory.signal.view.setUint32(0x1000, 0x24420001, false);
    system.memory.signal.view.setUint32(0x1004, 13, false);
    system.enableRsp(rsp.step);
    system.memory.write32(0x04040010, 1);
  }
  const [native, restored, reference] = systems as [N64System, N64System, N64System];
  native.enableRsp(() => {
    throw new Error('draw breakpoint');
  });
  native.step(cpu.step);
  assert.throws(() => native.step(cpu.step), /draw breakpoint/);
  const state = native.snapshot();
  assert.equal(state.pendingSignalInstruction, true);
  assert.equal(state.cpu.instructions, 2);
  restored.memory.ram.bytes.set(native.memory.ram.bytes);
  restored.memory.signal.memory.set(native.memory.signal.memory);
  restored.restore(state);
  native.enableRsp(rsp.step);
  native.step(cpu.step);
  restored.step(cpu.step);
  reference.step(cpu.step);
  reference.step(cpu.step);
  assert.deepEqual(native.snapshot(), reference.snapshot());
  assert.deepEqual(restored.snapshot(), reference.snapshot());
  assert.equal(native.cpu.r(1), 2n);
  assert.equal(native.rsp.r(2), 1);
  assert.equal(native.ticks, 2);
});

test('a complete N64 checkpoint resumes CPU/RSP delay slots, DMA, PCM and controller traffic independently', async () => {
  const rom = Uint8Array.from({ length: 64 }, (_, i) => i),
    native = new N64System(rom, 0x80000000, 512),
    restored = new N64System(rom, 0x80000000, 512);
  const words = [0x10000001, 0x24010007, 0];
  words.forEach((word, i) => native.memory.ram.write32(i * 4, word));
  const program = await importStaticProgram<Vr4300Machine>(
    liftVr4300(words.map((word, i) => decodeVr4300(word, 0x80000000 + i * 4))),
  );
  const rspWords = [0x10000001, 0x24020009, 13];
  rspWords.forEach((word, i) => native.memory.signal.view.setUint32(0x1000 + i * 4, word, false));
  const rspProgram = await importStaticProgram<RspMachine>(
    liftRsp(rspWords.map((word, i) => decodeRsp(word, i * 4))),
  );
  for (const system of [native, restored]) {
    system.enableRsp(rspProgram.step);
  }
  native.memory.write32(0x04040010, 1); // Clear HALT.
  native.memory.write32(0x04600000, 0x300);
  native.memory.write32(0x04600004, 0x10000008);
  native.memory.write32(0x0460000c, 15);
  native.memory.ram.bytes.set([1, 3, 0, 0, 0, 0, 0xfe], 0x200);
  native.memory.ram.bytes[0x23f] = 1;
  native.memory.write32(0x04800000, 0x200);
  native.memory.write32(0x04800010, 0x1fc007c0);
  native.memory.ram.write64(0x100, 0x123456787fff8000n);
  native.memory.write32(0x04500000, 0x100);
  native.memory.write32(0x04500010, 0);
  native.memory.write32(0x04500008, 1);
  native.memory.write32(0x04500004, 8);
  native.memory.write32(0x04040000, 0x800);
  native.memory.write32(0x04040004, 0x100);
  native.memory.write32(0x04040008, 7);
  native.cpu.fpu.registers[2] = 0x7ff8000000001234n;
  native.cpu.control.tlb[0] = { pageMask: 0, entryHi: 0x4000, entryLo0: 7, entryLo1: 71 };
  native.advanceClock();
  native.step(program.step);
  const state = native.snapshot();
  assert.equal(state.cpu.delaySlot, true);
  assert.equal(state.rsp.delaySlot, true);
  restored.memory.ram.bytes.set(native.memory.ram.bytes);
  restored.memory.signal.memory.set(native.memory.signal.memory);
  restored.restore(state);
  state.cpu.control.tlb[0]!.entryHi = 0;
  state.devices.peripheral.active!.remaining = 0;
  state.devices.serial.active!.remaining = 0;
  state.devices.audio.queue[0]!.cursor = 999;
  state.devices.signal.queue[0]!.remaining = 0;
  const samples = [[], []] as number[][][];
  [native, restored].forEach((system, i) => {
    system.memory.audio.output = (left, right) => samples[i]!.push([left, right]);
  });
  for (const system of [native, restored]) {
    system.step(program.step);
    for (let tick = 0; tick < 520; tick++) {
      system.advanceClock();
    }
  }
  assert.equal(restored.cpu.r(1), 7n);
  assert.equal(restored.rsp.r(2), 9);
  assert.equal(restored.memory.pif[3], 5);
  assert.equal(restored.memory.pif[4], 0);
  assert.equal(restored.memory.pif[5], 2); // No controller accessory attached.
  assert.deepEqual(samples[1], samples[0]);
  assert.equal(samples[0]!.length, 1);
  assert.deepEqual(restored.snapshot(), native.snapshot());
  assert.deepEqual(restored.memory.ram.bytes, native.memory.ram.bytes);
  assert.deepEqual(restored.memory.signal.memory, native.memory.signal.memory);
});

test('N64 memory keeps KSEG aliases, big-endian cartridge/PIF reads and strict unmapped devices', () => {
  const rom = Uint8Array.from([0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]);
  const memory = new N64Memory(rom);
  rom[0] = 0;
  assert.equal(memory.read32(0xb0000000), 0x80371240);
  memory.write64(0x80000100, 0x123456789abcdef0n);
  assert.equal(memory.read64(0xa0000100), 0x123456789abcdef0n);
  memory.write32(0xbfc007fc, 8);
  assert.equal(memory.read8(0x1fc007ff), 8);
  assert.throws(() => memory.write32(0x10000000, 0), /read-only/);
  assert.throws(() => memory.read32(0x04900000), /not implemented/);
  assert.throws(() => memory.read32(0x80000001), /Unaligned/);
  assert.throws(() => memory.read8(0x04300000), /require a word/);
});

test('MI paired mask commands and interrupt acknowledgement are observable', () => {
  const mi = new N64Interrupts();
  mi.pending = 0x3f;
  assert.equal(mi.asserted, false);
  mi.writeMask(0x800); // Set DP mask.
  assert.equal(mi.mask, 32);
  assert.equal(mi.asserted, true);
  mi.writeMode(0x800); // Clear DP interrupt only.
  assert.equal(mi.pending, 31);
  assert.equal(mi.asserted, false);
  mi.writeMask(0x80); // Set VI mask.
  assert.equal(mi.asserted, true);
  mi.writeMask(0x440); // Clear VI/DP masks.
  assert.equal(mi.mask, 0);
  mi.writeMask(0xaaa);
  assert.equal(mi.mask, 63);
  mi.writeMask(0x555);
  assert.equal(mi.mask, 0);
});

test('PI schedules ROM bytes, asserts completion and permits explicit acknowledgement/reset', () => {
  const rom = Uint8Array.from({ length: 64 }, (_, index) => index);
  const memory = new N64Memory(rom);
  memory.write32(0xa4600000, 0x100);
  memory.write32(0xa4600004, 0x10000008);
  memory.write32(0xa460000c, 15);
  assert.equal(memory.read32(0xa4600010), 1);
  assert.equal(memory.ram.bytes[0x100], 0);
  memory.peripheral.advance(15);
  assert.equal(memory.read32(0xa4600010), 1);
  memory.peripheral.advance(1);
  assert.equal(memory.read32(0xa4600010), 0);
  assert.deepEqual([...memory.ram.bytes.subarray(0x100, 0x110)], [...rom.subarray(8, 24)]);
  assert.equal(memory.interrupts.pending & 16, 16);
  memory.write32(0xa4600010, 2);
  assert.equal(memory.interrupts.pending & 16, 0);
  memory.write32(0xa4600000, 0x200);
  memory.write32(0xa4600004, 0x10000000);
  memory.write32(0xa460000c, 15);
  memory.write32(0xa4600010, 1);
  memory.peripheral.advance(100);
  assert.equal(memory.ram.bytes[0x201], 0);
  assert.equal(memory.peripheral.transfers.length, 1);
  memory.write32(0xa4600004, 0x10000040);
  assert.throws(() => memory.write32(0xa460000c, 7), /exceeds/);
});

test('cached controller packets refresh on every SI read and survive an independent checkpoint', () => {
  const ram = new Uint8Array(4096),
    pif = new Uint8Array(64);
  const serial = new N64Serial(ram, pif, () => {}, 0);
  ram.set([0xff, 1, 4, 1, 0xff, 0xff, 0xff, 0xff, 0xfe], 0x100);
  ram[0x13f] = 1;
  serial.write(0, 0x100);
  serial.write(0x10, 0x1fc007c0);
  serial.advance(512);
  assert.equal(serial.controllerReads, 0);
  const copyRam = ram.slice(),
    copyPif = pif.slice();
  const restored = new N64Serial(copyRam, copyPif, () => {}, 0);
  restored.restore(serial.snapshot());
  for (const [device, bytes] of [
    [serial, ram],
    [restored, copyRam],
  ] as const) {
    device.buttons = 0x1000;
    device.stickX = -37;
    device.stickY = 28;
    device.write(4, 0x1fc007c0);
    device.advance(512);
    assert.deepEqual([...bytes.subarray(0x104, 0x108)], [0x10, 0, 219, 28]);
    assert.equal(device.controllerReads, 1);
    device.onControllerRead = () => {
      device.buttons = 0x8000;
      device.stickX = 0;
      device.stickY = 0;
    };
    device.write(4, 0x1fc007c0); // No packet write between polls.
    device.advance(512);
    assert.deepEqual([...bytes.subarray(0x104, 0x108)], [0x80, 0, 0, 0]);
    assert.equal(device.controllerReads, 2);
  }
});

test('SI DMA exchanges controller commands and EEPROM blocks through PIF RAM', () => {
  const ram = new Uint8Array(4096),
    pif = new Uint8Array(64);
  let interrupt = false;
  const serial = new N64Serial(
    ram,
    pif,
    (asserted) => {
      interrupt = asserted;
    },
    512,
  );
  const exchange = (request: number[]) => {
    ram.fill(0, 0x100, 0x140);
    ram.set(request, 0x100);
    ram[0x13f] = 1;
    serial.write(0, 0x100);
    serial.write(0x10, 0x1fc007c0);
    assert.equal(serial.read(0x18) & 1, 1);
    serial.advance(511);
    assert.equal(interrupt, false);
    serial.advance(1);
    assert.equal(interrupt, true);
    serial.write(0x18, 0);
    serial.write(4, 0x1fc007c0);
    serial.advance(512);
    serial.write(0x18, 0);
    return [...ram.subarray(0x100, 0x140)];
  };
  const identify = exchange([1, 3, 0, 0, 0, 0, 0xfe]);
  assert.deepEqual(identify.slice(3, 6), [5, 0, 2]);
  serial.buttons = 0x8120;
  serial.stickX = -64;
  serial.stickY = 78;
  assert.deepEqual(exchange([1, 4, 1, 0, 0, 0, 0, 0xfe]).slice(3, 7), [0x81, 0x20, 0xc0, 78]);
  assert.deepEqual(exchange([0, 0, 0, 0, 1, 3, 0, 0, 0, 0, 0xfe]).slice(7, 10), [0, 0x80, 0]);
  exchange([0, 0, 0, 0, 10, 1, 5, 2, 10, 20, 30, 40, 50, 60, 70, 80, 0, 0xfe]);
  assert.deepEqual(
    exchange([0, 0, 0, 0, 2, 8, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0xfe]).slice(8, 16),
    [10, 20, 30, 40, 50, 60, 70, 80],
  );
  const absent = exchange([0, 1, 3, 0, 0, 0, 0, 0xfe]);
  assert.equal(absent[2]! & 0x80, 0x80);
});

test('AI consumes signed stereo samples from a two-entry FIFO at the programmed rate', () => {
  const ram = new Uint8Array(64),
    view = new DataView(ram.buffer);
  [32767, -32768, 16384, -16384, 1, -1, 2, -2].forEach((value, index) =>
    view.setInt16(index * 2, value, false),
  );
  let interrupt = false;
  const audio = new N64Audio(ram, (asserted) => {
    interrupt = asserted;
  });
  const heard: number[][] = [];
  audio.output = (left, right) => {
    heard.push([left, right]);
  };
  audio.write(0x10, 99);
  audio.write(0x14, 1);
  audio.write(0, 0);
  audio.write(4, 8);
  audio.write(0, 8);
  audio.write(4, 8);
  assert.equal(audio.read(0x0c), 0xc0000000);
  audio.advance(1000);
  assert.equal(heard.length, 0);
  audio.write(8, 1);
  audio.advance(Math.ceil((200 * 93750000) / 49656530));
  assert.deepEqual(heard, [
    [32767 / 32768, -1],
    [0.5, -0.5],
  ]);
  assert.equal(audio.read(0x0c), 0x40000000);
  assert.equal(interrupt, true);
  audio.write(0x0c, 0);
  assert.equal(interrupt, false);
  audio.advance(Math.ceil((200 * 93750000) / 49656530));
  assert.equal(audio.frames, 4);
  assert.equal(audio.read(0x0c), 0);
  assert.equal(interrupt, true);
});

test('the N64 machine enters the guest CP1 exception before committing a disabled load', async () => {
  const system = new N64System(new Uint8Array(4096), 0x80000000);
  const word = 0xc4000100; // LWC1 f0, $100(zero)
  system.memory.write32(0, word);
  const program = await importStaticProgram<Vr4300Machine>(
    liftVr4300([decodeVr4300(word, 0x80000000)]),
  );
  system.step(program.step);
  assert.equal(system.cpu.pc, 0x80000180);
  assert.equal(system.cpu.control.read(14), 0x80000000);
  assert.equal(system.cpu.control.read(13) & 0x3000007c, 0x1000002c);
  assert.equal(system.cpu.control.read(12) & 2, 2);
  assert.equal(system.cpu.fpu.registers[0], 0n);
  assert.equal(system.synchronousExceptions, 1);
  assert.equal(system.ticks, 1);
});

test('VI uses its PAL divisors, raises the programmed line interrupt and clears it on write', () => {
  const memory = new N64Memory(new Uint8Array(4096));
  memory.write32(0x04400018, 625);
  memory.write32(0x0440001c, 3177);
  memory.write32(0x0440000c, 2);
  memory.video.advance(6000);
  assert.equal(memory.video.currentHalfLine, 2);
  assert.equal(memory.interrupts.pending & 8, 8);
  memory.write32(0x04400010, 0);
  assert.equal(memory.interrupts.pending & 8, 0);
  memory.video.advance(1875000);
  assert.ok(memory.video.fields >= 1);
});

test('SP DMA preserves the selected memory bank, stride, busy bits and semaphore behavior', () => {
  const memory = new N64Memory(new Uint8Array(4096));
  memory.ram.bytes.set(
    Array.from({ length: 32 }, (_, index) => index + 1),
    0x100,
  );
  memory.write32(0x04040000, 0x1ff8);
  memory.write32(0x04040004, 0x100);
  memory.write32(0x04040008, (8 << 20) | (1 << 12) | 7); // Two 8-byte rows, 8-byte RDRAM stride.
  assert.equal(memory.read32(0x04040010) & 12, 4);
  memory.signal.advance(10);
  assert.deepEqual([...memory.signal.memory.subarray(0x1ff8, 0x2000)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    [...memory.signal.memory.subarray(0x1000, 0x1008)],
    [17, 18, 19, 20, 21, 22, 23, 24],
  );
  assert.equal(memory.read32(0x04040018), 0);
  assert.equal(memory.read32(0x0404001c), 0);
  assert.equal(memory.read32(0x0404001c), 1);
  memory.write32(0x0404001c, 123);
  assert.equal(memory.read32(0x0404001c), 0);
  memory.write32(0x04040010, 0x400);
  assert.equal(memory.read32(0x04040010) & 0x80, 0x80);
  memory.write32(0x04040010, 0x200);
  assert.equal(memory.read32(0x04040010) & 0x80, 0);
  assert.throws(() => memory.write32(0x04040010, 1), /starting RSP microcode/);
});

test('the coupled RSP clock retires two instructions per three CPU ticks and BREAK reaches MI', async () => {
  const system = new N64System(new Uint8Array(4096), 0);
  const words = [0x24010007, 0x24210001, 13]; // ADDIU r1,0,7; ADDIU r1,r1,1; BREAK
  words.forEach((word, i) => system.memory.signal.view.setUint32(0x1000 + i * 4, word, false));
  const program = await importStaticProgram<RspMachine>(
    liftRsp(words.map((word, i) => decodeRsp(word, i * 4))),
  );
  system.enableRsp(program.step);
  system.memory.write32(0x0430000c, 2); // Enable SP interrupt at MI.
  system.memory.write32(0x04040010, 0x105); // Clear HALT/BROKE, enable interrupt on BREAK.
  system.advanceClock();
  assert.equal(system.rsp.instructions, 0);
  system.advanceClock();
  assert.equal(system.rsp.r(1), 7);
  system.memory.write32(0x04040010, 1); // Clearing an already-clear HALT must not restart it.
  assert.equal(system.memory.signal.starts, 1);
  system.advanceClock();
  assert.equal(system.rsp.r(1), 8);
  assert.equal(system.memory.signal.pc, 8);
  system.advanceClock();
  system.advanceClock();
  assert.equal(system.memory.signal.status & 3, 3);
  assert.equal(system.memory.signal.breaks, 1);
  assert.equal(system.memory.interrupts.asserted, true);
  assert.equal(system.memory.signal.pc, 12);
  assert.equal(system.cpu.instructions, 0); // Explicit paused-CPU device fixture.
  system.advanceClock();
  assert.equal(system.rsp.instructions, 3);
  system.memory.write32(0x04040010, 8); // Acknowledge SP interrupt, retaining HALT/BROKE.
  assert.equal(system.memory.interrupts.asserted, false);
});

test('restoring SP DMA preserves queued work without sharing mutable transfer records', () => {
  const source = new N64Memory(new Uint8Array(4096)),
    restored = new N64Memory(new Uint8Array(4096));
  for (const memory of [source, restored]) {
    memory.ram.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0x100);
  }
  source.signal.write(0, 0xff8);
  source.signal.write(4, 0x100);
  source.signal.write(8, 7);
  source.signal.advance(3);
  const state = source.signal.snapshot();
  restored.signal.restore(state);
  state.queue[0]!.remaining = 999;
  source.signal.advance(6);
  restored.signal.advance(6);
  assert.deepEqual(restored.signal.snapshot(), source.signal.snapshot());
  assert.deepEqual(restored.signal.memory, source.signal.memory);
});

test('RDP FIFO setup exposes aligned pointers and stops before acknowledging unrendered work', () => {
  const memory = new N64Memory(new Uint8Array(0));
  memory.signal.view.setUint32(0x100, 0xc1000000, false); // Unsupported command, not an RDP no-op.
  memory.write32(0x0410000c, 2); // XBUS commands from RSP DMEM.
  memory.write32(0x04100000, 0x107);
  assert.equal(memory.read32(0x04100000), 0x100);
  assert.equal(memory.read32(0x0410000c), 0x481);
  memory.write32(0x04100004, 0x107); // Empty initial range.
  assert.equal(memory.read32(0x04100008), 0x100);
  assert.equal(memory.read32(0x0410000c), 0x81);
  memory.write32(0x0410000c, 8); // Freeze before extending the range.
  memory.write32(0x04100004, 0x110);
  assert.equal(memory.read32(0x04100008), 0x100);
  assert.throws(() => memory.write32(0x0410000c, 4), /command \$1 is not implemented/);
  assert.equal(memory.read32(0x04100008), 0x100);
  assert.equal(memory.interrupts.pending & 32, 0);
  assert.throws(() => memory.read32(0x04100010), /counters are not implemented/);
});

test('deferred device calls preserve ordinary CPU observations, DMA ordering, audio and inspection', () => {
  for (const limit of [1, 7, 31, 63, 257, 4096]) {
    const systems = [
      new N64System(new Uint8Array(32), 0x80000000),
      new N64System(new Uint8Array(32), 0x80000000, 0, true),
    ];
    const observations: number[][] = [[], []],
      samples: number[][][] = [[], []];
    for (const [index, s] of systems.entries()) {
      const m = s.memory;
      s.cpu.control.write(11, 53);
      m.write32(0x04600000, 0x300);
      m.write32(0x04600004, 0x10000000);
      m.write32(0x0460000c, 15);
      m.ram.bytes.set([1, 3, 0, 0, 0, 0, 0xfe], 0x200);
      m.ram.bytes[0x23f] = 1;
      m.write32(0x04800000, 0x200);
      m.write32(0x04800010, 0x1fc007c0);
      m.ram.write64(0x100, 0x123456787fff8000n);
      m.write32(0x04500000, 0x100);
      m.write32(0x04500010, 31);
      m.write32(0x04500008, 1);
      m.write32(0x04500004, 8);
      m.audio.output = (l, r) => samples[index]!.push([l, r]);
      m.write32(0x0440001c, 200);
      m.write32(0x04400018, 20);
      m.write32(0x0440000c, 13);
      for (let tick = 0; tick < limit; tick++) {
        s.step((c) => {
          c.begin(c.pc, 0, 0);
          if ([7, 17, 47, 257, 999, 2501].includes(tick)) {
            for (const address of [0x04400010, 0x0450000c, 0x04040018]) {
              observations[index]!.push(m.read32(address));
            }
            observations[index]!.push(c.control.read(9));
          }
          if (tick === 41) {
            m.write32(0x04400010, 0);
            m.write32(0x0440001c, 201);
          }
          if (tick === 127) {
            m.ram.write32(0x500, 0xaabbccdd);
            m.write32(0x04040000, 0x100);
            m.write32(0x04040004, 0x500);
            m.write32(0x04040008, 7);
          }
          c.finish();
        });
      }
    }
    const [reference, fast] = systems as [N64System, N64System];
    // Direct memory inspection also synchronizes elapsed device time.
    assert.deepEqual(fast.memory.snapshot(), reference.memory.snapshot());
    assert.deepEqual(fast.snapshot(), reference.snapshot());
    assert.deepEqual(fast.memory.ram.bytes, reference.memory.ram.bytes);
    assert.deepEqual(fast.memory.signal.memory, reference.memory.signal.memory);
    assert.deepEqual(observations[1], observations[0]);
    assert.deepEqual(samples[1], samples[0]);
    if (limit === 4096) {
      assert.ok(fast.executionStats.deviceBatches < limit / 10);
    }
  }
});

test('RSP DMA wait-loop coalescing stops at the same DMA/interrupt boundary in every clock phase', async () => {
  const cpu = await importStaticProgram<Vr4300Machine>(
    liftVr4300([
      decodeVr4300(0x1000ffff, 0x80000000),
      decodeVr4300(0, 0x80000004),
      decodeVr4300(0x1000ffff, 0x80000180),
      decodeVr4300(0, 0x80000184),
    ]),
  );
  const words = [0x400b3000, 0x1560fffe, 0, 13];
  const rsp = (await importStaticProgram<RspMachine>(
    liftRsp(words.map((word, i) => decodeRsp(word, i * 4))),
  )) as RspProgram;
  for (const phase of [0, 1, 2]) {
    for (const limit of [7, 127, 519, 520, 521, 553, 1000]) {
      const systems = [
        new N64System(new Uint8Array(32), 0x80000000),
        new N64System(new Uint8Array(32), 0x80000000, 0, true),
      ];
      for (const [index, s] of systems.entries()) {
        for (const at of [0, 0x180]) {
          s.memory.ram.write32(at, 0x1000ffff);
          s.memory.ram.write32(at + 4, 0);
        }
        words.forEach((word, i) => s.memory.signal.view.setUint32(4096 + i * 4, word, false));
        s.enableRsp(rsp.step, undefined, index ? rsp.runLocal : undefined);
        s.cpu.control.write(12, 0x8401);
        s.cpu.control.write(11, 537);
        s.memory.write32(0x0430000c, 2);
        s.memory.write32(0x04040000, 0x100);
        s.memory.write32(0x04040004, 0x500);
        s.memory.write32(0x04040008, 4095);
        s.memory.write32(0x04040010, 0x105);
        const state = s.snapshot();
        state.signalPhase = phase;
        s.restore(state);
        while (s.ticks < limit) {
          if (!index || !s.advanceIdle(limit - s.ticks)) {
            s.step(cpu.step);
          }
        }
      }
      const [reference, fast] = systems as [N64System, N64System];
      assert.deepEqual(fast.snapshot(), reference.snapshot(), `phase ${phase}, limit ${limit}`);
      assert.deepEqual(fast.memory.signal.memory, reference.memory.signal.memory);
      if (limit >= 127) {
        assert.ok(fast.rsp.executionStats.controlWaitInstructions > 0);
      }
    }
  }
});
