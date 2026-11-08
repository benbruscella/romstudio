import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, sha256, VERSION } from '../../../../core.js';
import { readBounded } from '../../../../files.js';
import { repositoryRoot } from '../../../../paths.js';
import { D64Image } from '../../../../media/d64.js';
import { AddressSpace } from '../../../../memory.js';
import { Machine } from '../../../../runtime/mos6502.js';
import { recover } from '../../../../transpiler/recover.js';
import { decode, listing } from '../../../../transpiler/mos6502.js';
import { liftObservedShapes } from '../../../../transpiler/static.js';
import { importStaticProgram } from '../../../../transpiler/program.js';
import { C64SystemBus } from '../../../../systems/c64/system.js';
import { C64RasterDisplay } from '../../../../systems/c64/raster.js';
import { captureC64 } from '../../../../systems/c64/snapshot.js';
import { NebulusStartup } from '../code/startup.js';
import { encodePng } from '../../../../png.js';
import type { StartupOptions } from '../../../../startup.js';

interface NebulusRecipe {
  id: string;
  version: number;
  title: string;
  system: string;
  timing: string;
  joystickPort: number;
  media: { name: string; sha256: string; boot: boolean }[];
  launch: {
    file: string;
    loadAddress: number;
    entry: number;
    sysPrefixAddress: number;
    sysPrefix: number[];
    expectedBytes: number[];
  };
  recovery: {
    maxInstructions: number;
    maxVariants: number;
    maxBoundaryOperations: number;
    undocumentedOpcodes: number[];
  };
  menu: { address: number; completedPolls: number; expectedBytes: number[]; expectedFile: string };
  notes: string[];
}
function validateRecipe(value: unknown): asserts value is NebulusRecipe {
  const r = value as NebulusRecipe | null;
  const bytes = (v: unknown): v is number[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 32 &&
    v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (
    !r ||
    r.id !== 'nebulus-nfi-us' ||
    !Number.isInteger(r.version) ||
    r.version < 1 ||
    typeof r.title !== 'string' ||
    r.system !== 'c64' ||
    r.timing !== 'pal-6569' ||
    r.joystickPort !== 2 ||
    !Array.isArray(r.media) ||
    r.media.length !== 1 ||
    !r.media[0] ||
    typeof r.media[0].name !== 'string' ||
    basename(r.media[0].name) !== r.media[0].name ||
    r.media[0].name === '.' ||
    r.media[0].name === '..' ||
    !/^[a-f0-9]{64}$/.test(r.media[0].sha256) ||
    r.media[0].boot !== true ||
    !r.launch ||
    r.launch.loadAddress !== 0x801 ||
    r.launch.entry !== 0x828 ||
    r.launch.sysPrefixAddress !== 0x805 ||
    !bytes(r.launch.sysPrefix) ||
    !bytes(r.launch.expectedBytes) ||
    typeof r.launch.file !== 'string' ||
    !r.recovery ||
    !Array.isArray(r.recovery.undocumentedOpcodes) ||
    !r.menu ||
    r.menu.address !== 0xab91 ||
    !Number.isInteger(r.menu.completedPolls) ||
    r.menu.completedPolls < 2 ||
    r.menu.completedPolls > 600 ||
    !bytes(r.menu.expectedBytes) ||
    typeof r.menu.expectedFile !== 'string' ||
    !Array.isArray(r.notes) ||
    r.notes.some((note) => typeof note !== 'string')
  ) {
    throw new Diagnostic(
      'NEBULUS_RECIPE',
      'Expected the reviewed Nebulus NFI recipe, pinned disk, launch bytes and bounded menu capture.',
    );
  }
}

/** A second title scenario, sharing the media reader, CPU and C64 services while
 * keeping its packer, launch preconditions and release inputs separate. */
export async function bootNebulus(options: StartupOptions & { workspaceFill?: number } = {}) {
  const recipeBytes = await readBounded(
    options.recipePath ?? join(repositoryRoot, 'src/games/c64/nebulus/recipe.json'),
    65536,
  );
  const recipe: unknown = JSON.parse(recipeBytes.toString());
  validateRecipe(recipe);
  const medium = recipe.media[0]!,
    mediaDirectory = resolve(options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/nebulus'));
  const diskBytes = await readBounded(join(mediaDirectory, medium.name), 206114);
  if (sha256(diskBytes) !== medium.sha256) {
    throw new Diagnostic(
      'MEDIA_HASH',
      `SHA-256 mismatch for ${medium.name}. Original media were not changed.`,
    );
  }
  const disk = new D64Image(diskBytes),
    matches = disk.entries.filter(
      (entry) => entry.name === recipe.launch.file && entry.type === 'PRG',
    );
  if (matches.length !== 1) {
    throw new Diagnostic('BOOT_FILE', 'Nebulus boot PRG must resolve to exactly one entry.');
  }
  const files = new Map(
    disk.entries.map((entry) => [
      entry.name,
      { ...disk.extract(entry), mediaHash: disk.hash, fileId: entry.id },
    ]),
  );
  const boot = disk.extract(matches[0]!);
  const fill = options.workspaceFill ?? 0;
  if (!Number.isInteger(fill) || fill < 0 || fill > 255) {
    throw new Diagnostic('LAUNCH_FIXTURE', 'Workspace fixture must be a byte.');
  }
  const prepare = () => {
    const space = new AddressSpace(),
      load = space.loadPrg(boot.bytes, boot.spans);
    if (load.start !== recipe.launch.loadAddress) {
      throw new Diagnostic('LOAD_ADDRESS', 'Nebulus PRG load address differs from recipe.');
    }
    const bus = new C64SystemBus(space),
      machine = new Machine(bus);
    machine.pc = recipe.launch.entry;
    machine.guard(recipe.launch.sysPrefixAddress, recipe.launch.sysPrefix);
    machine.guard(machine.pc, recipe.launch.expectedBytes);
    // Explicit post-LOAD preconditions. FD50-style workspace clearing is a
    // launch fixture; later BASIC activity is not claimed to be reproduced.
    bus.seed(0xae, load.end & 255);
    bus.seed(0xaf, load.end >>> 8);
    bus.seed(0x330, 0xa5);
    bus.seed(0x331, 0xf4); // Stock LOAD vector, before the release saves it.
    for (const [start, end] of [
      [2, 0x102],
      [0x200, 0x400],
    ]) {
      for (let address = start!; address < end!; address++) {
        bus.seed(address, fill);
      }
    }
    const title = new NebulusStartup(bus, files);
    let display: C64RasterDisplay | undefined,
      polls = 0;
    const boundary = () => {
      if (!display && machine.pc === 0x8000 && title.diskReads.length) {
        machine.guard(0x8000, [0xa9, 1, 0x4c, 0x17, 0x80]);
        display = new C64RasterDisplay(bus);
      }
      if (display && machine.pc === recipe.menu.address) {
        polls++;
      }
      const serviced = title.boundary(machine);
      display?.capture(bus);
      return serviced;
    };
    const finished = () =>
      machine.pc === recipe.menu.address && polls >= recipe.menu.completedPolls;
    return {
      space,
      bus,
      machine,
      title,
      boundary,
      finished,
      get display() {
        return display;
      },
      get polls() {
        return polls;
      },
    };
  };
  const native = prepare();
  const result = recover(native.machine, {
    ...recipe.recovery,
    stopAt: 0xffff,
    stopWhen: native.finished,
    onFetch: (instruction) => native.bus.observe(instruction),
    onBoundary: native.boundary,
  });
  const fingerprint = (runtime: ReturnType<typeof prepare>) => ({
    state: sha256(JSON.stringify(captureC64(runtime.bus, runtime.machine))),
    display: runtime.display ? sha256(runtime.display.pixels) : null,
    gameRam: sha256(runtime.bus.bytes.subarray(0x400)),
    inputs: sha256(JSON.stringify(runtime.title.inputs)),
    diskReads: sha256(JSON.stringify(runtime.title.diskReads)),
  });
  const expected = fingerprint(native),
    scratch = new Uint8Array(65536);
  const instructions = result.variants.map((variant) => {
    variant.bytes.forEach((byte, offset) => {
      scratch[(variant.address + offset) & 65535] = byte;
    });
    return decode(scratch, variant.address, recipe.recovery);
  });
  const emitted = liftObservedShapes(instructions);
  let staticReplay = false;
  if (result.stop === 'checkpoint') {
    const generated = await importStaticProgram(emitted);
    const replay = prepare();
    let operations = 0;
    while (!replay.finished()) {
      if (++operations > recipe.recovery.maxInstructions + recipe.recovery.maxBoundaryOperations) {
        throw new Diagnostic('NEBULUS_REPLAY', 'Static startup replay exceeded its bound.');
      }
      if (!replay.boundary()) {
        generated.step(replay.machine);
      }
    }
    staticReplay = JSON.stringify(fingerprint(replay)) === JSON.stringify(expected);
  }
  const checks = [
    { name: 'menu-checkpoint', passed: result.stop === 'checkpoint' && native.finished() },
    {
      name: 'menu-bytes',
      passed: recipe.menu.expectedBytes.every(
        (byte, offset) =>
          native.bus.known[recipe.menu.address + offset] &&
          native.bus.bytes[recipe.menu.address + offset] === byte,
      ),
    },
    {
      name: 'original-game-file-loaded',
      passed:
        native.title.diskReads.length === 1 &&
        native.title.diskReads[0]!.name === recipe.menu.expectedFile,
    },
    {
      name: 'intro-inputs',
      passed:
        JSON.stringify(native.title.inputs.map((input) => input.kind)) ===
        JSON.stringify(['intro-space', 'picture-fire']),
    },
    { name: 'trainer-relocation', passed: native.title.relocationCount === 1 },
    { name: 'recovered-display', passed: !!native.display && native.display.frames >= 2 },
    { name: 'static-startup-replay', passed: staticReplay },
  ];
  const passed = checks.every((check) => check.passed);
  const identity = {
    romstudio: VERSION,
    recipe: sha256(recipeBytes),
    media: disk.hash,
    stage: 'nebulus-startup-v1',
    workspaceFill: fill,
  };
  const key = sha256(JSON.stringify(identity)),
    directory = resolve(
      options.outputDirectory ?? join(repositoryRoot, 'dist/work/trials', key, 'nebulus-boot'),
    );
  await mkdir(join(directory, 'runtime'), { recursive: true });
  const inventory = disk.entries.map((entry) => {
    const file = disk.extract(entry);
    return {
      ...entry,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
      provenance: file.spans,
    };
  });
  const report = {
    schemaVersion: 1,
    title: recipe.title,
    bootId: key,
    identity,
    status: passed ? 'menu-reached' : 'partial',
    build: { status: 'partial-title', artifact: 'translated-startup', playable: false },
    verification: {
      startupChecks: passed ? 'passed' : 'failed',
      staticReplay: staticReplay ? 'passed' : 'unverified',
      hardwareParity: 'unverified',
      gameplay: 'unverified',
      checks,
    },
    stop: result.stop,
    ...(result.gap ? { gap: result.gap } : {}),
    state: result.state,
    hashes: expected,
    launch: {
      file: recipe.launch.file,
      entry: recipe.launch.entry,
      entryEvidence: 'reviewed SYS2088 prefix',
      timing: recipe.timing,
      joystickPort: recipe.joystickPort,
      workspaceFill: fill,
      workspaceRanges: [
        [2, 0x102],
        [0x200, 0x400],
      ],
      loadEndPointer: [0xae, 0xaf],
      loadVector: 0xf4a5,
    },
    menu: {
      address: recipe.menu.address,
      completedPolls: native.polls,
      videoFrames: native.display?.frames ?? 0,
    },
    inputs: native.title.inputs,
    diskReads: native.title.diskReads,
    services: native.bus.kernal.calls,
    annotations: {
      xorRelocations: native.title.relocationCount,
      screenClearControls: native.title.screenClears,
    },
    observed: {
      exactByteVariants: result.variants.length,
      staticShapes: emitted.shapes.length,
      invalidations: result.invalidations,
      extensions: recipe.recovery.undocumentedOpcodes,
    },
    limitations: [
      'Startup capture only. Gameplay, completion, menu options and a browser export are not verified.',
      'Workspace and initial LOAD state are declared launch fixtures. BASIC execution and actual power-on state are not reproduced.',
      'KERNAL LOAD supplies pinned file bytes; drive execution, serial handshaking and disk timing are absent.',
      'The XOR copy preserves unknown padding. It includes the following LDA that overwrites the unknown final accumulator.',
      'No trainer keys are pressed. The release lists two trainers; their implementation and default settings remain unverified.',
      'VIC DMA stalls, sub-instruction timing, SID synthesis and independent hardware parity remain unverified.',
    ],
    assets: { policy: 'local-only', publicAssets: [] },
    notes: recipe.notes,
    recent: result.recent,
  };
  const checkpoint = captureC64(native.bus, native.machine);
  const sourceDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n'),
    writeFile(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint)),
    writeFile(join(directory, 'memory.bin'), native.bus.bytes),
    writeFile(join(directory, 'known-memory.bin'), native.bus.known),
    writeFile(join(directory, 'observed-variants.json'), JSON.stringify(result.variants)),
    writeFile(join(directory, 'startup.asm'), listing(instructions)),
    writeFile(join(directory, 'startup.js'), emitted.javascript),
    writeFile(join(directory, 'startup.ts'), emitted.typescript),
    ...['mos6502.js', 'mos6502.d.ts'].map((name) =>
      copyFile(join(sourceDirectory, 'runtime', name), join(directory, 'runtime', name)),
    ),
    ...(native.display
      ? [writeFile(join(directory, 'menu.png'), encodePng(320, 200, native.display.pixels))]
      : []),
  ]);
  return { outputDirectory: directory, report, checkpoint };
}
