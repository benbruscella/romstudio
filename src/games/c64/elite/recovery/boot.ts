import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import { repositoryRoot, gameBuildDirectory } from '../../../../paths.js';
import { D64Image } from '../../../../media/d64.js';
import { AddressSpace } from '../../../../memory.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { captureC64 } from '../../../../systems/c64/snapshot.js';
import { EliteStartup } from '../code/startup.js';
import { recover } from '../../../../transpiler/recover.js';
import { emitRecoveredProgram, importStaticProgram } from '../../../../transpiler/program.js';
import type { StartupOptions } from '../../../../startup.js';

/** Pinned original boot, including the actual packer and ten declined trainer
 * branches. Only the documented release boundaries live in EliteStartup. */
export async function bootElite(options: StartupOptions = {}) {
  const recipeBytes = await readBounded(
    options.recipePath ?? join(repositoryRoot, 'src/games/c64/elite/recipe.json'),
    65536,
  );
  const recipe = JSON.parse(recipeBytes.toString()) as {
    media: { name: string; sha256: string }[];
    launch: { file: string; entry: number };
  };
  const media = recipe.media[0]!;
  if (
    recipe.media.length !== 1 ||
    media.name !== 'ELITE-E.D64' ||
    recipe.launch.file !== 'ELITE V1.1+' ||
    recipe.launch.entry !== 0x80b
  ) {
    throw new Diagnostic('ELITE_RECIPE', 'Expected the reviewed Elite V1.1+ launch.');
  }
  const diskBytes = await readBounded(
    join(options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/elite'), media.name),
    206114,
  );
  if (sha256(diskBytes) !== media.sha256) {
    throw new Diagnostic('MEDIA_HASH', 'Elite disk hash does not match its recipe.');
  }
  const disk = new D64Image(diskBytes),
    entry = disk.entries.find((entry) => entry.name === recipe.launch.file && entry.type === 'PRG');
  if (!entry) {
    throw new Diagnostic('BOOT_FILE', 'The pinned Elite launch file is missing.');
  }
  const file = disk.extract(entry);
  const prepare = () => {
    const space = new AddressSpace(),
      load = space.loadPrg(file.bytes, file.spans),
      bus = new C64SystemBus(space),
      machine = new Machine(bus);
    machine.pc = recipe.launch.entry;
    for (const [start, end] of [
      [2, 0x102],
      [0x200, 0x400],
    ]) {
      for (let address = start!; address < end!; address++) {
        bus.seed(address, 0);
      }
    }
    bus.seed(0xae, load.end & 255);
    bus.seed(0xaf, load.end >>> 8);
    bus.seed(0x330, 0xa5);
    bus.seed(0x331, 0xf4);
    const title = new EliteStartup(bus);
    return { bus, machine, title };
  };
  const native = prepare(),
    trace = recover(native.machine, {
      stopAt: 0x8d6a,
      maxInstructions: 12000000,
      maxVariants: 60000,
      maxBoundaryOperations: 100000,
      onFetch: (instruction) => native.bus.observe(instruction),
      onBoundary: () => native.title.boundary(native.machine),
    });
  if (trace.stop !== 'checkpoint') {
    throw new Diagnostic(
      'ELITE_BOOT',
      JSON.stringify({ stop: trace.stop, gap: trace.gap, recent: trace.recent }),
    );
  }
  native.machine.guard(0x8d6a, [0xad, 0, 0xdc]);
  const fingerprint = (runtime: ReturnType<typeof prepare>) => ({
    state: sha256(JSON.stringify(captureC64(runtime.bus, runtime.machine))),
    inputs: sha256(JSON.stringify(runtime.title.inputs)),
    marker: runtime.title.discardedMarkerReads,
  });
  const program = emitRecoveredProgram([trace]),
    compiled = await importStaticProgram(program),
    replay = prepare();
  let operations = 0;
  while (replay.machine.pc !== 0x8d6a) {
    if (++operations > 12500000) {
      throw new Diagnostic('ELITE_REPLAY', 'Startup replay exceeded its bound.');
    }
    if (!replay.title.boundary(replay.machine)) {
      compiled.step(replay.machine);
    }
  }
  const checks = [
    {
      name: 'startup-static-replay',
      passed: JSON.stringify(fingerprint(native)) === JSON.stringify(fingerprint(replay)),
    },
    {
      name: 'trainers-disabled',
      passed: native.title.inputs.filter((input) => input.kind === 'trainer-no').length === 10,
    },
    {
      name: 'original-picture-input',
      passed:
        native.title.inputs.filter((input) => input.kind === 'release-picture-space').length === 1,
    },
    { name: 'discarded-marker-annotation', passed: native.title.discardedMarkerReads === 1 },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('ELITE_BOOT_PARITY', JSON.stringify(checks));
  }
  const directory = resolve(
    options.outputDirectory ?? join(gameBuildDirectory('c64/elite'), 'analysis/boot'),
  );
  await mkdir(directory, { recursive: true });
  const checkpoint = captureC64(native.bus, native.machine),
    report = {
      status: 'menu-reached',
      stop: trace.stop,
      state: trace.state,
      bootId: sha256(recipeBytes),
      verification: { startupChecks: 'passed', hardwareParity: 'unverified', checks },
      inputs: native.title.inputs,
      media: disk.hash,
      diskReads: [{ name: entry.name, sha256: sha256(file.bytes), mediaHash: disk.hash }],
      fixtures: {
        workspaceFill: 0,
        ranges: [
          [2, 0x102],
          [0x200, 0x400],
        ],
        loadVector: 0xf4a5,
      },
      limitations: [
        'Functional KERNAL startup services and declared workspace replace a full BASIC/firmware boot. Service timing is approximate.',
        'Original release picture is left with a recorded Space input; all ten trainers follow their N branches.',
      ],
    };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint));
  await writeFile(join(directory, 'trace.json'), JSON.stringify(trace));
  return { outputDirectory: directory, checkpoint, report, trace };
}
