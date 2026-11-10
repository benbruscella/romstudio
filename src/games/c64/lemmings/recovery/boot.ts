import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import { repositoryRoot } from '../../../../paths.js';
import { runTrial } from './trial.js';
import { AddressSpace } from '../../../../memory.js';
import { D64Image } from '../../../../media/d64.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
import { disassemble, listing } from '../../../../transpiler/mos6502.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { renderC64 } from '../../../../systems/c64/render.js';
import { LemmingsBoot } from '../code/startup.js';
import { encodePng } from '../../../../png.js';

import type { StartupOptions } from '../../../../startup.js';

/** Shared preparation; each scenario still executes afresh from the disk PRG. */
export async function prepareStartup(options: StartupOptions = {}) {
  const trial = await runTrial(options);
  if (trial.verification.status !== 'passed') {
    throw new Diagnostic('BOOTSTRAP_VERIFICATION', 'Bootstrap fixture must pass before startup.');
  }
  const recipePath =
    options.recipePath ?? join(repositoryRoot, 'src/games/c64/lemmings/recipe.json');
  const recipe = JSON.parse((await readBounded(recipePath, 65536)).toString()) as {
    trainers?: boolean;
    menu?: {
      stopAt: number;
      maxInstructions: number;
      maxVariants: number;
      maxBoundaryOperations: number;
      expectedBytes: number[];
      expectedFiles: string[];
    };
  };
  if (
    !recipe.menu ||
    recipe.trainers !== false ||
    !Array.isArray(recipe.menu.expectedBytes) ||
    recipe.menu.expectedBytes.length < 1 ||
    recipe.menu.expectedBytes.length > 32 ||
    recipe.menu.expectedBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
    !Array.isArray(recipe.menu.expectedFiles) ||
    recipe.menu.expectedFiles.length < 1 ||
    recipe.menu.expectedFiles.length > 29 ||
    recipe.menu.expectedFiles.some((name) => typeof name !== 'string' || !/^[A-Z]{2}$/.test(name))
  ) {
    throw new Diagnostic(
      'BOOT_RECIPE',
      'Startup requires menu bytes, file order and the trainers-disabled recipe.',
    );
  }
  const settings = recipe.menu;
  const medium = trial.inventory.find((m) => m.boot)!;
  const disk = new D64Image(
    await readBounded(
      join(
        resolve(options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/lemmings')),
        medium.name,
      ),
      206114,
    ),
  );
  if (disk.hash !== medium.sha256) {
    throw new Diagnostic('MEDIA_HASH', 'Boot medium changed after validation.');
  }
  const files = new Map(
    disk.entries.map((entry) => [
      entry.name,
      { ...disk.extract(entry), mediaHash: disk.hash, fileId: entry.id },
    ]),
  );
  const bootFile = files.get(trial.manifest.launch.file)!;
  const space = new AddressSpace();
  space.loadPrg(bootFile.bytes, bootFile.spans);
  const bus = new C64SystemBus(space),
    machine = new Machine(bus);
  machine.pc = trial.manifest.launch.entry;
  return { trial, settings, space, bus, machine, files };
}

export async function bootTrial(options: StartupOptions = {}) {
  const { trial, settings, space, bus, machine, files } = await prepareStartup(options);
  const title = new LemmingsBoot(bus, machine, files);
  const result = recover(machine, {
    ...settings,
    onFetch: (instruction) => bus.observe(instruction),
    onBoundary: (s) => title.boundary(s),
    describeVariant: (instruction) => ({
      firstSeenEpoch: bus.epoch,
      bytes: instruction.bytes.map((_, offset) => {
        const address = (instruction.address + offset) & 65535;
        return bus.lastWriter[address]! >= 0
          ? { address, writerPc: bus.lastWriter[address] }
          : { address, original: space.source(address) ?? null };
      }),
    }),
  });
  const key = sha256(
    JSON.stringify({ buildId: trial.manifest.buildId, stage: 'startup-services-v1', settings }),
  );
  const directory = join(trial.outputDirectory, `boot-${key}`);
  await mkdir(directory, { recursive: true });
  const checks = [
    {
      name: 'menu-checkpoint',
      passed: result.stop === 'checkpoint' && machine.pc === settings.stopAt,
    },
    {
      name: 'menu-bytes',
      passed: settings.expectedBytes.every(
        (byte, index) => bus.known[machine.pc + index] && bus.bytes[machine.pc + index] === byte,
      ),
    },
    {
      name: 'trainers-disabled',
      passed:
        title.inputs.filter((input) => input.kind === 'trainer-no').length === 12 &&
        new Set(
          title.inputs.filter((input) => input.kind === 'trainer-no').map((input) => input.caller),
        ).size === 12,
    },
    {
      name: 'disk-read-order',
      passed:
        JSON.stringify(title.diskReads.map((read) => read.name)) ===
        JSON.stringify(settings.expectedFiles),
    },
    {
      name: 'disk-streams-consumed',
      passed: title.diskReads.every((read) => read.complete && read.length === read.consumed),
    },
    { name: 'loader-relocation', passed: title.relocationCount === 1 },
    { name: 'display-enabled', passed: !!(bus.vic.registers[0x11]! & 16) },
  ];
  let renderGap: string | undefined;
  let png: Buffer | undefined;
  const videoBank = (~bus.cia2.read(0) & 3) * 0x4000;
  try {
    png = encodePng(
      320,
      200,
      renderC64({
        ram: bus.bytes,
        known: bus.known,
        colour: bus.colour,
        registers: bus.vic.registers,
        bank: videoBank,
      }),
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    renderGap = error.message;
  }
  checks.push({ name: 'recovered-display', passed: !!png });
  const passed = checks.every((check) => check.passed);
  const report = {
    schemaVersion: 1,
    buildId: trial.manifest.buildId,
    bootId: key,
    status: passed ? 'menu-reached' : 'partial',
    build: { status: 'partial', artifact: 'translated-startup-analysis', playable: false },
    verification: {
      startupChecks: passed ? 'passed' : 'failed',
      bootstrapFixture: trial.verification.status,
      hardwareParity: 'unverified',
      gameplay: 'unverified',
      checks,
    },
    stop: result.stop,
    ...(result.gap ? { gap: result.gap } : {}),
    ...(renderGap ? { renderGap } : {}),
    state: result.state,
    hashes: {
      memory: sha256(bus.bytes),
      knownMemory: sha256(bus.known),
      colour: sha256(bus.colour),
      display: png ? sha256(png) : null,
    },
    inputs: title.inputs,
    diskReads: title.diskReads,
    annotations: {
      relocatedUnknownPadding: title.relocationCount,
      unusedBitFlagReads: title.deadFlagReads,
    },
    services: bus.kernal.calls,
    interrupts: { delivered: bus.irqEntries, defaultKernal: bus.defaultIrqCalls },
    observed: {
      instructionVariants: result.variants.length,
      invalidations: result.invalidations,
      boundaryOperations: result.boundaryOperations,
    },
    video: {
      bank: videoBank,
      registers: [...bus.vic.registers],
      kind: 'register-snapshot',
      palette: 'romstudio-preview',
    },
    launchSeeds: {
      processorPort: 0x37,
      processorDirection: 0x2f,
      screenPage: 4,
      palFlag: 1,
      jiffyClock: 0,
      colourRam: 0,
      paddleInputs: [255, 255],
    },
    limitations: [
      'PAL clock advances at instruction boundaries. VIC DMA, interrupt polling delays and cycle-level bus phases are not implemented.',
      'Screen clear has documented CPU counts; composite startup/reset/default IRQ service cycle and instruction counts are functional estimates.',
      'Serial handshaking and drive execution are replaced by a byte stream from pinned media. The original CE7C decompressor still executes.',
      'Colour RAM starts at zero and its unmodelled upper nibble reads $F0. SID bus-latch decay and audio synthesis are not implemented.',
      'The joystick-only profile exposes open paddle inputs ($FF); mouse input is absent.',
      'A guarded bulk copy preserves unknown padding as unknown. A reviewed BIT skip leaves unused overflow state unmodelled.',
      'The image is a static VIC register snapshot; split-screen raster history and sprite DMA are not captured.',
      'Menu reached under ROM Studio startup services. Independent hardware and gameplay parity remain unverified.',
    ],
    assets: { policy: 'local-only', publicAssets: [] },
    recent: result.recent,
  };
  const recovered = new AddressSpace();
  recovered.bytes.set(bus.bytes);
  recovered.loaded.set(bus.known);
  const cfg = disassemble(recovered, [settings.stopAt], 2048);
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(directory, 'memory.bin'), bus.bytes),
    writeFile(join(directory, 'known-memory.bin'), bus.known),
    writeFile(join(directory, 'colour.bin'), bus.colour),
    writeFile(join(directory, 'observed-variants.json'), JSON.stringify(result.variants) + '\n'),
    writeFile(join(directory, 'menu.asm'), listing(cfg.instructions)),
    ...(png ? [writeFile(join(directory, 'menu.png'), png)] : []),
  ]);
  return { outputDirectory: directory, report };
}
