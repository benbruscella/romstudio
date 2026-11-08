import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import type { StartupOptions } from '../../../../startup.js';
import { prepareStartup } from './boot.js';
import { repositoryRoot } from '../../../../paths.js';
import { D64Image } from '../../../../media/d64.js';
import { AddressSpace } from '../../../../memory.js';
import { recover } from '../../../../transpiler/recover.js';
import { disassemble, listing } from '../../../../transpiler/mos6502.js';
import { LemmingsBoot, type TitleFile } from '../code/startup.js';
import { decodeLevelHeader, decodeTerrain } from '../code/level-data.js';
import { renderC64 } from '../../../../systems/c64/render.js';
import { encodePng } from '../../../../png.js';

/** A mounted disk changes only when exactly one pinned disk has the requested
 * file. This replaces manual swapping; ambiguous requests remain a gap. */
export class LemmingsDisks {
  readonly mounts: { name: string; disk: number }[] = [];
  constructor(
    readonly disks: readonly ReadonlyMap<string, TitleFile>[],
    public active = 0,
  ) {}
  get(name: string): TitleFile | undefined {
    const present = this.disks[this.active]?.get(name);
    if (present) {
      return present;
    }
    const candidates = this.disks.flatMap((disk, index) => (disk.has(name) ? [index] : []));
    if (candidates.length !== 1) {
      return undefined;
    }
    this.active = candidates[0]!;
    this.mounts.push({ name, disk: this.active });
    return this.disks[this.active]!.get(name);
  }
}

export interface LevelOptions extends StartupOptions {
  level?: 1 | 2;
  /** Sensitivity fixture for the previous-level status buffer, not game data. */
  previousHeaderByte?: number;
}

/** Execute the original menu, loaders, setup and release routine. This remains
 * an analysis scenario; it is not the statically exported browser game. */
export async function runLevelToFirstSpawn(options: LevelOptions = {}) {
  const level = options.level ?? 1,
    previousHeaderByte = options.previousHeaderByte ?? 0;
  if (
    ![1, 2].includes(level) ||
    !Number.isInteger(previousHeaderByte) ||
    previousHeaderByte < 0 ||
    previousHeaderByte > 255
  ) {
    throw new Diagnostic(
      'LEVEL_OPTIONS',
      'This scenario supports levels 1 and 2 and a byte-valued previous-header fixture.',
    );
  }
  const { trial, settings, bus, machine } = await prepareStartup(options);
  const mediaDirectory = resolve(
    options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/lemmings'),
  );
  const maps = await Promise.all(
    trial.inventory.map(async (medium) => {
      const disk = new D64Image(await readBounded(join(mediaDirectory, medium.name), 206114));
      if (disk.hash !== medium.sha256) {
        throw new Diagnostic('MEDIA_HASH', 'A level medium changed after validation.');
      }
      return new Map(
        disk.entries.map((entry) => [
          entry.name,
          { ...disk.extract(entry), mediaHash: disk.hash, fileId: entry.id },
        ]),
      );
    }),
  );
  const disks = new LemmingsDisks(
    maps,
    trial.inventory.findIndex((medium) => medium.boot),
  );

  // The documented FD50 startup loop clears these workspaces. Seed only bytes
  // absent from the loaded PRG. This is a declared launch fixture, not a claim
  // to have reproduced every later BASIC write to zero page.
  for (let address = 2; address < 0x102; address++) {
    bus.seed(address, 0);
  }
  for (let address = 0x200; address < 0x400; address++) {
    bus.seed(address, 0);
  }
  // PA draws a *previous* level status before loading FA/FB. No previous level
  // exists in this scenario. The selected file must overwrite this entire
  // buffer before its contents count as recovered level data.
  for (let address = 0xe000; address < 0xe100; address++) {
    bus.seed(address, previousHeaderByte);
  }
  const title = new LemmingsBoot(bus, machine, disks);
  const trainerInput = bus.kernal.characterInput;
  const inputs: { kind: string; pc: number; value: number }[] = [];
  let selected = false,
    fireHeld = false;
  bus.kernal.characterInput = () => {
    const caller =
      ((machine.read(0x100 | ((machine.sp + 1) & 255)) |
        (machine.read(0x100 | ((machine.sp + 2) & 255)) << 8)) +
        1) &
      65535;
    if (title.startupComplete && caller === 0x91e3 && !selected) {
      machine.guard(0x91e3, [0xc9, 0x31]);
      if (machine.read(0x9bc2) !== 0) {
        throw new Diagnostic('LEVEL_SELECTOR', 'Expected the initial level-selection field.');
      }
      // Level 2 is a declared selector fixture; $9349 still generates the
      // original code and CB still chooses FB. File requests are not renamed.
      machine.write(0x9bc2, level - 1);
      selected = true;
      inputs.push({ kind: 'one-player-key', pc: caller, value: 0x31 });
      return 0x31;
    }
    return trainerInput();
  };
  const result = recover(machine, {
    stopAt: 0x1e69,
    maxInstructions: 30000000,
    maxVariants: 200000,
    maxBoundaryOperations: 200000,
    onFetch: (instruction) => bus.observe(instruction),
    onBoundary: (s) => {
      if (title.startupComplete && s.pc === 0x52a0) {
        s.guard(0x52a0, [0xad, 0, 0xdc, 0x29, 0x10]);
        if (!fireHeld) {
          inputs.push({ kind: 'fire-press', pc: s.pc, value: 0 });
        }
        fireHeld = true;
        bus.cia1.inputA &= ~16;
      }
      if (title.startupComplete && s.pc === 0x547d && fireHeld) {
        bus.cia1.inputA |= 16;
        fireHeld = false;
        inputs.push({ kind: 'fire-release', pc: s.pc, value: 1 });
      }
      return title.boundary(s);
    },
  });
  return { trial, settings, bus, machine, title, disks, inputs, result, level, previousHeaderByte };
}

export async function levelTrial(options: LevelOptions = {}) {
  const { trial, settings, bus, title, disks, inputs, result, level, previousHeaderByte } =
    await runLevelToFirstSpawn(options);
  const suffix = level === 1 ? 'A' : 'B';
  const expectedFiles = [...settings.expectedFiles, `F${suffix}`, `S${suffix}`];
  const headerOverwritten = Array.from(
    { length: 256 },
    (_, offset) => bus.lastWriter[0xe000 + offset]!,
  ).every((writer) => writer >= 0);
  let header: ReturnType<typeof decodeLevelHeader> | undefined;
  let terrain: ReturnType<typeof decodeTerrain> | undefined;
  let decodeGap: string | undefined;
  try {
    if (!headerOverwritten) {
      throw new Error('The previous-header fixture has not been completely overwritten.');
    }
    header = decodeLevelHeader(bus);
    terrain = decodeTerrain(bus);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    decodeGap = error.message;
  }
  const firstLemming =
    bus.known[0x5b7] && bus.bytes[0x5b7] === 1
      ? {
          x: (bus.bytes[0x456]! & 1) * 256 + bus.bytes[0x488]!,
          y: bus.bytes[0x4ba]!,
          modeByte: bus.bytes[0x424]!,
          animationByte: bus.bytes[0x456]!,
        }
      : undefined;
  const checks = [
    {
      name: 'first-spawn-checkpoint',
      passed: result.stop === 'checkpoint' && bus.bytes[0x1e69] === 0x60 && !!firstLemming,
    },
    {
      name: 'trainers-disabled',
      passed: title.inputs.filter((input) => input.kind === 'trainer-no').length === 12,
    },
    {
      name: 'disk-read-order',
      passed:
        JSON.stringify(title.diskReads.map((read) => read.name)) === JSON.stringify(expectedFiles),
    },
    {
      name: 'complete-disk-streams',
      passed: title.diskReads.every((read) => read.complete && read.consumed === read.length),
    },
    { name: 'previous-header-overwritten', passed: headerOverwritten },
    { name: 'level-header-and-terrain', passed: !!header && !!terrain },
    {
      name: 'spawn-from-entrance',
      passed:
        !!firstLemming &&
        header?.entrances.some(
          (entrance) => firstLemming.x === entrance.x + 2 && firstLemming.y === entrance.y + 5,
        ) === true,
    },
  ];
  const key = sha256(
    JSON.stringify({
      buildId: trial.manifest.buildId,
      stage: 'first-spawn-v2',
      level,
      previousHeaderByte,
    }),
  );
  const directory = join(trial.outputDirectory, `level-${level}-${key}`);
  await mkdir(directory, { recursive: true });
  let preview: Buffer | undefined, renderGap: string | undefined;
  const bank = (~bus.cia2.read(0) & 3) * 0x4000;
  try {
    preview = encodePng(
      320,
      200,
      renderC64({
        ram: bus.bytes,
        known: bus.known,
        colour: bus.colour,
        registers: bus.vic.registers,
        bank,
      }),
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    renderGap = error.message;
  }
  const terrainPng = terrain
    ? encodePng(terrain.width * 2, terrain.height, terrain.pixels)
    : undefined;
  const report = {
    schemaVersion: 1,
    buildId: trial.manifest.buildId,
    levelId: key,
    level,
    status: checks.every((check) => check.passed) ? 'first-lemming-spawned' : 'partial',
    build: { status: 'partial', artifact: 'recovered-level-analysis', playable: false },
    verification: {
      scenarioChecks: checks.every((check) => check.passed) ? 'passed' : 'failed',
      hardwareParity: 'unverified',
      gameplay: 'unverified',
      checks,
    },
    stop: result.stop,
    gap: result.gap,
    decodeGap,
    renderGap,
    state: result.state,
    header,
    firstLemming,
    diskReads: title.diskReads,
    diskMounts: disks.mounts,
    inputs: [...title.inputs, ...inputs],
    hashes: {
      memory: sha256(bus.bytes),
      knownMemory: sha256(bus.known),
      header: sha256(bus.bytes.subarray(0xe000, 0xe094)),
      terrain: terrain ? sha256(terrain.pairs) : null,
      collision: terrain ? sha256(terrain.collision) : null,
    },
    terrain: terrain
      ? {
          width: terrain.width,
          height: terrain.height,
          originY: terrain.originY,
          horizontalPixelScale: 2,
          format: 'two-bit-pairs-via-original-lookup-tables',
          ordinaryProbe: 'pair != 0',
          alternateProbe: 'pair != 0 && pair != 3',
          tableAddresses: [0x4800, 0x4900, 0x4a00, 0x4c00, 0x4e00],
        }
      : undefined,
    launchFixtures: {
      clearedWorkspaces: [
        [2, 0x101],
        [0x200, 0x3ff],
      ],
      previousHeader: { start: 0xe000, length: 256, byte: previousHeaderByte },
      levelSelector: level - 1,
    },
    video: { bank, registers: [...bus.vic.registers], kind: 'register-snapshot' },
    observed: {
      instructionVariants: result.variants.length,
      invalidations: result.invalidations,
      boundaryOperations: result.boundaryOperations,
    },
    limitations: [
      'Analysis executes translated original instructions. A playable static browser slice has not been exported.',
      'Startup workspaces and the previous-level status buffer are explicit launch fixtures; they are not measured hardware state.',
      'The VIC image is a register snapshot, so raster splits and multiplexed sprites can look incomplete. terrain.png is a diagnostic pair atlas, not a screenshot.',
      'Terrain probes preserve two observed predicates. Skill-specific collision behavior and terrain edits still need validation.',
      'PAL timing is approximate; VIC DMA, SID synthesis, independent hardware parity and full gameplay verification remain incomplete.',
    ],
    assets: { policy: 'local-only', publicAssets: [] },
    recent: result.recent,
  };
  const recovered = new AddressSpace();
  recovered.bytes.set(bus.bytes);
  recovered.loaded.set(bus.known);
  const cfg = disassemble(recovered, [0x1000, 0x1dd9, 0x287e, 0x28ec, 0x2910], 4096);
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(
      join(directory, 'level.json'),
      JSON.stringify({ header, firstLemming, terrain: report.terrain }, null, 2) + '\n',
    ),
    writeFile(join(directory, 'memory.bin'), bus.bytes),
    writeFile(join(directory, 'known-memory.bin'), bus.known),
    writeFile(join(directory, 'colour.bin'), bus.colour),
    writeFile(join(directory, 'level.asm'), listing(cfg.instructions)),
    writeFile(join(directory, 'observed-variants.json'), JSON.stringify(result.variants) + '\n'),
    ...(preview ? [writeFile(join(directory, 'level.png'), preview)] : []),
    ...(terrain && terrainPng
      ? [
          writeFile(join(directory, 'terrain.png'), terrainPng),
          writeFile(join(directory, 'terrain-pairs.bin'), terrain.pairs),
          writeFile(join(directory, 'ordinary-collision.bin'), terrain.collision),
        ]
      : []),
  ]);
  return { outputDirectory: directory, report };
}
