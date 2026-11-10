import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256, Diagnostic } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import { repositoryRoot } from '../../../../paths.js';
import { runTrial } from './trial.js';
import { D64Image } from '../../../../media/d64.js';
import { AddressSpace } from '../../../../memory.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
import { disassemble, listing } from '../../../../transpiler/mos6502.js';
import { C64RecoveryBus } from '../../../../systems/c64.js';

function regions(mask: Uint8Array): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  for (let a = 0; a < mask.length;) {
    if (!mask[a]) {
      a++;
      continue;
    }
    const start = a;
    while (a < mask.length && mask[a]) {
      a++;
    }
    result.push({ start, end: a });
  }
  return result;
}

export async function recoverTrial(
  options: {
    mediaDirectory?: string;
    recipePath?: string;
    outputDirectory?: string;
    stopAt?: number;
  } = {},
) {
  // Reuse the pinned-media validation and independently bounded bootstrap check.
  const trial = await runTrial(options);
  if (trial.verification.status !== 'passed') {
    throw new Diagnostic('BOOTSTRAP_VERIFICATION', 'Bootstrap fixture must pass before recovery.');
  }
  const recipePath =
    options.recipePath ?? join(repositoryRoot, 'src/games/c64/lemmings/recipe.json');
  const recipe = JSON.parse((await readBounded(recipePath, 65536)).toString()) as {
    recovery?: { stopAt: number; maxInstructions: number; maxVariants: number };
  };
  const settings = recipe.recovery;
  if (!settings) {
    throw new Diagnostic(
      'RECOVERY_RECIPE',
      'Recipe has no reviewed recovery checkpoint or execution budget.',
    );
  }
  const stopAt = options.stopAt ?? settings.stopAt;
  const bootMedium = trial.manifest.launch.bootMedium;
  const disk = new D64Image(
    await readBounded(
      join(
        resolve(options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/lemmings')),
        bootMedium,
      ),
      206114,
    ),
  );
  if (disk.hash !== trial.inventory.find((m) => m.boot)!.sha256) {
    throw new Diagnostic('MEDIA_HASH', 'Boot medium changed after validation.');
  }
  const entry = disk.entries.find(
    (e) => e.name === trial.manifest.launch.file && e.type === 'PRG',
  )!;
  const boot = disk.extract(entry),
    space = new AddressSpace();
  space.loadPrg(boot.bytes, boot.spans);
  const bus = new C64RecoveryBus(space),
    machine = new Machine(bus);
  machine.pc = trial.manifest.launch.entry;
  const result = recover(machine, {
    ...settings,
    stopAt,
    onFetch: (instruction) => bus.observe(instruction),
    describeVariant: (instruction) => ({
      firstSeenEpoch: bus.epoch,
      bytes: instruction.bytes.map((_, index) => {
        const address = (instruction.address + index) & 65535,
          writer = bus.lastWriter[address]!;
        return writer >= 0
          ? { address, writerPc: writer }
          : { address, original: space.source(address) ?? null };
      }),
    }),
  });
  const written = new Uint8Array(65536);
  for (let a = 0; a < 65536; a++) {
    if (bus.lastWriter[a]! >= 0) {
      written[a] = 1;
    }
  }
  const recovered = new AddressSpace();
  recovered.bytes.set(bus.bytes);
  recovered.loaded.set(bus.known);
  const cfg = disassemble(recovered, [machine.pc], 4096);
  const key = sha256(JSON.stringify({ buildId: trial.manifest.buildId, settings, stopAt }));
  const directory = join(trial.outputDirectory, `recovery-${key}`);
  await mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    recoveryId: key,
    buildId: trial.manifest.buildId,
    status: result.stop === 'checkpoint' ? 'checkpoint-reached' : 'partial',
    evidence: 'romstudio-generated-instruction-execution',
    hardwareParity: 'unverified',
    gameplay: 'unverified',
    assumptions: [
      'Processor-port DDR=$2F and data=$37.',
      'Synthetic VIC $D011=$1B; no hardware raster or stall timing.',
      'Uninitialised RAM reads stop execution.',
      'Only observed bootstrap I/O registers are modelled.',
    ],
    settings: { ...settings, stopAt },
    stop: result.stop,
    ...(result.gap ? { gap: result.gap } : {}),
    state: result.state,
    snapshotHash: sha256(bus.bytes),
    knownMemoryHash: sha256(bus.known),
    observed: {
      instructionVariants: result.variants.length,
      invalidations: result.invalidations,
      codeByteChanges: bus.epoch,
      writtenBytes: written.reduce((sum, b) => sum + b, 0),
      writtenRegions: regions(written),
      newlyWrittenExecutableRegions: regions(bus.executedAfterWrite),
    },
    changedCode: [...bus.changedCode].map(([address, changes]) => ({ address, ...changes })),
    ioWriteTail: bus.ioWrites,
    recent: result.recent,
    verification: {
      bootstrapFixture: trial.verification.status,
      recoveredSnapshot: 'unverified',
      description: 'No independent reference snapshot or game-state parity evidence.',
    },
    nextStage: { instructions: cfg.instructions.length, unresolved: cfg.unresolved },
    assets: { policy: 'local-only', publicAssets: [] },
  };
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(directory, 'observed-variants.json'), JSON.stringify(result.variants) + '\n'),
    writeFile(join(directory, 'memory.bin'), bus.bytes),
    writeFile(join(directory, 'known-memory.bin'), bus.known),
    writeFile(join(directory, 'next-stage.asm'), listing(cfg.instructions)),
    writeFile(join(directory, 'next-stage-control-flow.json'), JSON.stringify(cfg, null, 2) + '\n'),
  ]);
  return { outputDirectory: directory, report };
}
