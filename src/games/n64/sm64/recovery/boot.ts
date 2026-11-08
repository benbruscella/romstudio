import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import type { SourceObservation } from '../../../../contracts.js';
import { repositoryRoot, gameBuildDirectory } from '../../../../paths.js';
import type { StartupOptions } from '../../../../startup.js';
import type { Vr4300Machine } from '../../../../runtime/vr4300.js';
import {
  compileVr4300,
  decodeVr4300,
  liftVr4300,
  type Vr4300Instruction,
} from '../../../../transpiler/vr4300.js';
import { importStaticProgram, writeStaticProgram } from '../../../../transpiler/program.js';
import type { N64System } from '../../../../systems/n64/system.js';
import { N64SignalStart } from '../../../../systems/n64/signal.js';
import { bootSm64Entry } from './entry.js';
import { loadSm64Cartridge } from './cartridge.js';
import { prepareSm64Startup, sm64StartupFixture } from './fixture.js';
import { verifySm64AudioTask } from './audio.js';

export { bootSm64Entry } from './entry.js';

function runToSignalProcessor(
  system: N64System,
  step: (cpu: Vr4300Machine) => void,
  maxTicks: number,
) {
  try {
    while (system.ticks < maxTicks) {
      system.step(step);
    }
  } catch (error) {
    if (!(error instanceof N64SignalStart)) {
      throw error;
    }
    const task = Array.from({ length: 16 }, (_, index) =>
      system.memory.signal.view.getUint32(0xfc0 + index * 4, false),
    );
    if ((task[0] !== 1 && task[0] !== 2) || system.memory.signal.read(0x18) !== 0) {
      throw new Diagnostic(
        'SM64_SP_TASK',
        'The CPU reached RSP start without a complete known task.',
      );
    }
    return {
      kind: error.kind,
      cpuAddress: system.cpu.pc,
      rspAddress: error.address,
      command: error.command,
      task,
    };
  }
  throw new Diagnostic(
    'SM64_STARTUP_BUDGET',
    'SM64 did not reach the first RSP task within the declared CPU tick budget.',
  );
}

/** Execute the cartridge's actual CPU startup through its first SP task request.
 * The stop is an explicit backend boundary; it does not stand in for rendering. */
export async function bootSm64(options: StartupOptions = {}) {
  const outputDirectory = resolve(
    options.outputDirectory ?? join(gameBuildDirectory('n64/sm64'), 'analysis/startup'),
  );
  const entry = await bootSm64Entry({
    ...options,
    outputDirectory: join(outputDirectory, 'entry'),
  });
  const cartridge = await loadSm64Cartridge(options);
  const native = prepareSm64Startup(cartridge.rom);
  const shapes = new Map<
    string,
    {
      instruction: Vr4300Instruction;
      observation: SourceObservation;
      operation: (cpu: Vr4300Machine) => void;
    }
  >();
  const boundary = runToSignalProcessor(
    native,
    (cpu) => {
      const word = cpu.bus.read32(cpu.pc),
        key = `${cpu.pc}:${word}`;
      let shape = shapes.get(key);
      if (!shape) {
        const instruction = decodeVr4300(word, cpu.pc);
        shape = {
          instruction,
          operation: compileVr4300(instruction),
          observation: {
            address: cpu.pc,
            opcode: word,
            bytes: instruction.bytes,
            assembly: instruction.text,
            firstInstruction: cpu.instructions,
            visits: 0,
            provenance: {
              addressSpace: 'vr4300-cpu',
              evidence: 'first observed RAM word; complete write epochs remain unverified',
            },
          },
        };
        shapes.set(key, shape);
      }
      shape.observation.visits++;
      shape.operation(cpu);
    },
    15000000,
  );
  const generated = liftVr4300([...shapes.values()].map((shape) => shape.instruction));
  const compiled = await importStaticProgram<Vr4300Machine>(generated);
  const replay = prepareSm64Startup(cartridge.rom);
  const replayBoundary = runToSignalProcessor(replay, compiled.step, native.ticks + 1);
  const checks = [
    {
      name: 'independent-named-entry',
      passed: entry.report.verification.checks.every((check) => check.passed),
    },
    {
      name: 'original-vs-static-cpu',
      passed: JSON.stringify(native.cpu.snapshot()) === JSON.stringify(replay.cpu.snapshot()),
    },
    {
      name: 'original-vs-static-rdram',
      passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
    },
    {
      name: 'original-vs-static-sp-memory',
      passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
    },
    {
      name: 'original-vs-static-devices-and-clock',
      passed: JSON.stringify(native.snapshot()) === JSON.stringify(replay.snapshot()),
    },
    {
      name: 'original-vs-static-rsp-boundary',
      passed: JSON.stringify(boundary) === JSON.stringify(replayBoundary),
    },
    { name: 'cartridge-segment-dma', passed: native.memory.peripheral.transfers.length > 0 },
    {
      name: 'first-task-descriptor-and-microcode-dma',
      passed:
        native.memory.signal.transfers.some((transfer) => transfer.memory >= 0x1000) &&
        native.memory.signal.transfers.some((transfer) => transfer.memory < 0x1000),
    },
    {
      name: 'guest-interrupt-and-cp1-exception-paths',
      passed: native.interruptEntries > 0 && native.synchronousExceptions > 0,
    },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_STARTUP_PARITY', JSON.stringify(checks));
  }
  const audio = await verifySm64AudioTask(native, boundary.command);
  const report = {
    title: 'Super Mario 64 — Europe',
    status: 'first-rsp-task-reached',
    media: cartridge.identity,
    fixture: sm64StartupFixture,
    verification: {
      referenceReplay: 'passed',
      hardwareTiming: 'unverified',
      gameplay: 'unverified',
      checks,
    },
    state: native.cpu.snapshot(),
    timingModel: 'functional-instruction-clock',
    startup: {
      shapes: shapes.size,
      ticks: native.ticks,
      interruptEntries: native.interruptEntries,
      synchronousExceptions: native.synchronousExceptions,
      cartridgeTransfers: native.memory.peripheral.transfers,
      controllerTransfers: native.memory.serial.transfers,
      videoFields: native.memory.video.fields,
      audioFrames: native.memory.audio.frames,
    },
    boundary,
    audio: audio.report,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeStaticProgram(generated, outputDirectory);
  await writeFile(join(outputDirectory, 'rdram.bin'), native.memory.ram.bytes);
  await writeFile(join(outputDirectory, 'sp-memory.bin'), native.memory.signal.memory);
  await writeFile(
    join(outputDirectory, 'sp-state.json'),
    JSON.stringify(native.memory.signal.snapshot(), null, 2) + '\n',
  );
  await writeStaticProgram(audio.program, join(outputDirectory, 'rsp'));
  await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const mappings = [...shapes.values()]
    .map((shape) => shape.observation)
    .sort((a, b) => a.address - b.address || a.opcode - b.opcode);
  const source =
    JSON.stringify(
      {
        schemaVersion: 1,
        architecture: 'mips3-vr4300',
        scope:
          'Verified CPU startup through the first RSP task request. RSP audio and graphics have separate IMEM source studies, including the first textured task. Later CPU capture, hardware precision and browser gameplay remain unverified.',
        mappings,
      },
      null,
      2,
    ) + '\n';
  await writeFile(
    join(outputDirectory, 'original.asm'),
    mappings
      .map(
        (item) =>
          `${item.address.toString(16).toUpperCase()}  ${item.opcode.toString(16).toUpperCase().padStart(8, '0')}  ${item.assembly}`,
      )
      .join('\n') + '\n',
  );
  const studyDirectory = join(outputDirectory, 'source-study');
  const files: Record<string, string> = {};
  const put = async (name: string, content: string) => {
    await mkdir(join(studyDirectory, name.slice(0, name.lastIndexOf('/'))), { recursive: true });
    await writeFile(join(studyDirectory, name), content);
    files[name] = sha256(content);
  };
  await put('game-code/program.ts', generated.typescript);
  await put('game-code/observed-source.json', source);
  await put('game-code/rsp/program.ts', audio.program.typescript);
  await put(
    'game-code/rsp/observed-source.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        architecture: 'n64-rsp',
        scope:
          'First original audio task and explicit named-MIXER fixtures. RSP addresses are offsets within IMEM, separate from VR4300 CPU addresses. Gameplay and music remain unverified.',
        mappings: audio.mappings,
      },
      null,
      2,
    ) + '\n',
  );
  for (const [name, path] of [
    ['README.md', 'README.md'],
    ['STARTUP.md', 'docs/STARTUP.md'],
    ['CPU.md', 'docs/CPU.md'],
    ['AUDIO.md', 'docs/AUDIO.md'],
    ['GRAPHICS.md', 'docs/GRAPHICS.md'],
  ]) {
    await put(
      'learn/' + name,
      await readFile(join(repositoryRoot, 'src/games/n64/sm64', path!), 'utf8'),
    );
  }
  await writeFile(
    join(studyDirectory, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        kind: 'verified-source-study',
        titleId: 'sm64',
        gameKey: 'n64/sm64',
        system: 'n64',
        exportId: sha256(JSON.stringify(files)),
        build: { status: 'partial-title', playable: false, artifact: 'verified-cpu-startup-study' },
        verification: { ...report.verification, rspAudio: audio.report.verification },
        files,
      },
      null,
      2,
    ) + '\n',
  );
  return { outputDirectory, report, checkpoint: native };
}
