import { Diagnostic, sha256 } from '../../../../core.js';
import type { RspMachine } from '../../../../runtime/rsp.js';
import { N64System } from '../../../../systems/n64/system.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';
import { importStaticProgram } from '../../../../transpiler/program.js';
import { mixAudioSamples } from '../code/audio.js';

function runTask(system: N64System, command: number, budget = 150000): void {
  system.memory.signal.write(0x10, command);
  while ((system.memory.signal.status & 1) === 0 && system.ticks < budget) {
    system.advanceClock();
  }
  if ((system.memory.signal.status & 0x203) !== 0x203 || system.memory.signal.read(0x18) !== 0) {
    throw new Diagnostic(
      'SM64_AUDIO_TASK',
      'Audio microcode did not finish its DMA and signal task-done/BREAK within the RSP budget.',
    );
  }
}

/** An explicitly isolated command fixture. Entry comes from the original
 * dispatch table, not from an address borrowed from a different ROM version. */
function checkMixer(
  memory: Uint8Array,
  step: (machine: RspMachine) => void,
  onCase?: (name: string) => void,
) {
  const inputAddress = 0x6c0,
    outputAddress = 0x8c0;
  const pairs = [
    [32767, 32767],
    [-32768, -32768],
    [32767, -32768],
    [-32768, 32767],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [16385, 16384],
    [-16385, -16384],
  ];
  const cases: { count: number; gain: number; passed: boolean }[] = [];
  for (const count of [0, 16, 48]) {
    for (const gain of [0, 16384, 32767, -16384, -32768]) {
      onCase?.(`isolated-mixer-${count}-samples-gain-${gain}`);
      const system = new N64System(new Uint8Array(0), 0),
        signal = system.memory.signal;
      signal.memory.set(memory);
      signal.status = 0x41; // Isolated command fixture: halted, interrupt on BREAK.
      signal.pc = signal.view.getUint16(0x10 + 12 * 2, false) & 0xffc;
      signal.view.setUint16(0x364, count * 2, false);
      const input = Int16Array.from({ length: count }, (_, i) => pairs[i % pairs.length]![0]!);
      const destination = Int16Array.from(
        { length: count },
        (_, i) => pairs[i % pairs.length]![1]!,
      );
      signal.memory.fill(0xa5, outputAddress - 16, outputAddress + count * 2 + 16);
      input.forEach((value, i) => signal.view.setInt16(inputAddress + i * 2, value, false));
      destination.forEach((value, i) => signal.view.setInt16(outputAddress + i * 2, value, false));
      system.rsp.set(24, 0x360);
      system.rsp.set(25, (0x100 << 16) | 0x300);
      system.rsp.set(26, gain & 65535);
      // No further commands: both the current chunk and total remainder are zero.
      system.rsp.set(27, 0);
      system.rsp.set(30, 0);
      system.enableRsp(step);
      runTask(system, 5, 10000);
      const expected = mixAudioSamples(input, destination, gain);
      const passed =
        expected.every(
          (value, i) => signal.view.getInt16(outputAddress + i * 2, false) === value,
        ) &&
        input.every((value, i) => signal.view.getInt16(inputAddress + i * 2, false) === value) &&
        signal.memory
          .subarray(outputAddress - 16, outputAddress)
          .every((value) => value === 0xa5) &&
        signal.memory
          .subarray(outputAddress + count * 2, outputAddress + count * 2 + 16)
          .every((value) => value === 0xa5);
      cases.push({ count, gain, passed });
    }
  }
  return {
    cases,
    samples: cases.reduce((total, item) => total + item.count, 0),
    passed: cases.every((item) => item.passed),
  };
}

/** Resume the exact CPU-produced SP memory, DMA registers and start command.
 * CPU execution is paused for this bounded study; audio is synthesized by the
 * cartridge's RSP instructions, never by the named MIXER explanation above. */
export async function verifySm64AudioTask(checkpoint: N64System, command: number) {
  const ram = checkpoint.memory.ram.bytes.slice(),
    sp = checkpoint.memory.signal.memory.slice();
  const signalState = checkpoint.memory.signal.snapshot();
  const prepare = () => {
    const system = new N64System(new Uint8Array(0), 0);
    system.memory.ram.bytes.set(ram);
    system.memory.signal.memory.set(sp);
    system.memory.signal.restore(signalState);
    return system;
  };
  const recovery = new RspRecovery('first-audio-task');
  const native = prepare();
  native.enableRsp(recovery.step);
  runTask(native, command);
  const taskInstructions = native.rsp.instructions,
    taskShapes = recovery.shapeCount;
  const mixer = checkMixer(native.memory.signal.memory, recovery.step, (name) => {
    recovery.trace = name;
  });
  const program = recovery.emit();
  const compiled = await importStaticProgram<RspMachine>(program);
  const replay = prepare();
  replay.enableRsp(compiled.step);
  runTask(replay, command);
  const staticMixer = checkMixer(native.memory.signal.memory, compiled.step);
  const checks = [
    {
      name: 'original-vs-static-rsp-state',
      passed: JSON.stringify(native.rsp.snapshot()) === JSON.stringify(replay.rsp.snapshot()),
    },
    {
      name: 'original-vs-static-rsp-rdram',
      passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
    },
    {
      name: 'original-vs-static-rsp-memory',
      passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
    },
    {
      name: 'original-vs-static-rsp-devices-and-clock',
      passed: JSON.stringify(native.snapshot()) === JSON.stringify(replay.snapshot()),
    },
    {
      name: 'rsp-task-done-break-and-interrupt',
      passed:
        (native.memory.signal.status & 0x203) === 0x203 &&
        (native.memory.interrupts.pending & 1) === 1,
    },
    {
      name: 'rsp-output-dma',
      passed: native.memory.signal.transfers.some((transfer) => transfer.write),
    },
    { name: 'independent-named-mixer-original', passed: mixer.passed },
    { name: 'independent-named-mixer-static', passed: staticMixer.passed },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_AUDIO_PARITY', JSON.stringify(checks));
  }
  const outputTransfers = native.memory.signal.transfers.filter((transfer) => transfer.write);
  return {
    program,
    mappings: recovery.observations,
    report: {
      status: 'first-rsp-audio-task-completed',
      fixture: {
        cpu: 'paused',
        initialRspRegisters: 'zero',
        clock: 'fresh-functional-device-clock',
        startCommand: command,
        inputRdram: sha256(ram),
        inputSpMemory: sha256(sp),
        signalState,
      },
      verification: {
        referenceReplay: 'passed',
        hardwareTiming: 'unverified',
        gameMusic: 'unverified',
        checks,
      },
      instructions: taskInstructions,
      taskShapes,
      shapes: recovery.shapeCount,
      ticks: native.ticks,
      state: native.rsp.snapshot(),
      signal: native.memory.signal.snapshot(),
      outputTransfers,
      namedMixer: mixer,
    },
  };
}
