import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { gameBuildDirectory, repositoryRoot } from '../../../../paths.js';
import { Vr4300Machine, Vr4300Ram } from '../../../../runtime/vr4300.js';
import { compileVr4300, decodeVr4300, liftVr4300 } from '../../../../transpiler/vr4300.js';
import { importStaticProgram, writeStaticProgram } from '../../../../transpiler/program.js';
import { sm64Entry, interpretSm64Entry } from '../code/startup.js';
import type { StartupOptions } from '../../../../startup.js';
import { loadSm64Cartridge } from './cartridge.js';

/** Verify actual entry words after an explicit post-IPL3 load fixture. This
 * establishes an architectural CPU milestone, not console boot or gameplay. */
export async function bootSm64Entry(options: StartupOptions = {}) {
  const cartridge = await loadSm64Cartridge(options);
  const view = new DataView(cartridge.rom.buffer);
  const instructions = Array.from({ length: sm64Entry.words }, (_, index) =>
    decodeVr4300(
      view.getUint32(sm64Entry.romOffset + index * 4, false),
      sm64Entry.address + index * 4,
    ),
  );
  const generated = liftVr4300(instructions);
  const compiled = await importStaticProgram<Vr4300Machine>(generated);
  const prepare = () => {
    const bus = new Vr4300Ram(4 * 1024 * 1024, 0xcd);
    bus.bytes.set(
      cartridge.rom.subarray(sm64Entry.romOffset, sm64Entry.romOffset + sm64Entry.words * 4),
      sm64Entry.address & 0x1fffffff,
    );
    const machine = new Vr4300Machine(bus, sm64Entry.address);
    for (let index = 1; index < 32; index++) {
      machine.set64(index, BigInt(index) * 0x10000000000001n);
    }
    return { bus, machine };
  };
  const native = prepare(),
    replay = prepare();
  const interpreted = interpretSm64Entry(native.bus.bytes, native.machine.registers);
  const operations = new Map(
    instructions.map((instruction) => [instruction.address, compileVr4300(instruction)]),
  );
  const run = (machine: Vr4300Machine, step: (machine: Vr4300Machine) => void) => {
    while (machine.pc !== sm64Entry.main) {
      if (machine.instructions >= 200000) {
        throw new Diagnostic(
          'SM64_ENTRY_BUDGET',
          'The original entry did not reach main within its instruction bound.',
        );
      }
      step(machine);
    }
  };
  const observations = new Map<number, { firstInstruction: number; visits: number }>();
  run(native.machine, (machine) => {
    const seen = observations.get(machine.pc) ?? {
      firstInstruction: machine.instructions,
      visits: 0,
    };
    seen.visits++;
    observations.set(machine.pc, seen);
    const operation = operations.get(machine.pc);
    if (!operation) {
      throw new Diagnostic('SM64_ENTRY_TARGET', 'The entry left its reviewed instruction range.');
    }
    operation(machine);
  });
  run(replay.machine, compiled.step);
  const checks = [
    {
      name: 'original-vs-static-registers',
      passed:
        JSON.stringify(native.machine.snapshot()) === JSON.stringify(replay.machine.snapshot()),
    },
    {
      name: 'original-vs-static-memory',
      passed: sha256(native.bus.bytes) === sha256(replay.bus.bytes),
    },
    { name: 'named-entry-memory', passed: sha256(native.bus.bytes) === sha256(interpreted.ram) },
    {
      name: 'named-entry-registers',
      passed: native.machine.registers.every(
        (value, index) => value === interpreted.registers[index],
      ),
    },
    {
      name: 'entry-delay-slot-and-count',
      passed:
        native.machine.pc === interpreted.pc &&
        native.machine.instructions === interpreted.instructions,
    },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_ENTRY_PARITY', JSON.stringify(checks));
  }
  const outputDirectory = resolve(
    options.outputDirectory ?? join(gameBuildDirectory('n64/sm64'), 'analysis/entry'),
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeStaticProgram(generated, outputDirectory);
  const report = {
    title: 'Super Mario 64 — Europe',
    status: 'post-IPL3-entry-verified',
    media: cartridge.identity,
    fixture: {
      entry: sm64Entry.address,
      ramFill: 0xcd,
      initialRegisters: 'deterministic nonzero 64-bit values',
      consoleReset: 'unverified',
    },
    verification: {
      referenceReplay: 'passed',
      namedInterpretation: 'passed',
      hardwareTiming: 'unverified',
      gameplay: 'unverified',
      checks,
    },
    state: native.machine.snapshot(),
    timingModel: 'functional-instruction-count',
  };
  await Promise.all([
    writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(outputDirectory, 'program.ts'), generated.typescript),
    writeFile(
      join(outputDirectory, 'original.asm'),
      instructions
        .map(
          (instruction) =>
            `${instruction.address.toString(16).toUpperCase()}  ${instruction.word.toString(16).toUpperCase().padStart(8, '0')}  ${instruction.text}`,
        )
        .join('\n') + '\n',
    ),
    writeFile(
      join(outputDirectory, 'source-map.json'),
      JSON.stringify(
        instructions.map((instruction, index) => ({
          ...instruction,
          romOffset: sm64Entry.romOffset + index * 4,
        })),
        null,
        2,
      ),
    ),
  ]);
  const studyDirectory = join(outputDirectory, 'source-study');
  const studyFiles: Record<string, string> = {
    'game-code/program.ts': generated.typescript,
    'game-code/observed-source.json': JSON.stringify({
      schemaVersion: 1,
      architecture: 'mips3-vr4300',
      scope: 'Verified post-IPL3 entry routine only; the game backend is still under development.',
      mappings: instructions.map((instruction) => ({
        address: instruction.address,
        opcode: instruction.word,
        bytes: instruction.bytes,
        assembly: instruction.text,
        ...observations.get(instruction.address)!,
      })),
    }),
    'learn/README.md': await readFile(join(repositoryRoot, 'src/games/n64/sm64/README.md'), 'utf8'),
    'learn/STARTUP.md': await readFile(
      join(repositoryRoot, 'src/games/n64/sm64/docs/STARTUP.md'),
      'utf8',
    ),
  };
  for (const [name, source] of Object.entries(studyFiles)) {
    await mkdir(join(studyDirectory, name.slice(0, name.lastIndexOf('/'))), { recursive: true });
    await writeFile(join(studyDirectory, name), source);
  }
  const files = Object.fromEntries(
    Object.entries(studyFiles).map(([name, source]) => [name, sha256(source)]),
  );
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
        build: { status: 'partial-title', playable: false, artifact: 'verified-mips-entry-study' },
        verification: report.verification,
        files,
      },
      null,
      2,
    ) + '\n',
  );
  return { outputDirectory, report };
}
