import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, sha256, VERSION } from '../../../../core.js';
import { D64Image } from '../../../../media/d64.js';
import { AddressSpace } from '../../../../memory.js';
import { basicSys } from '../../../../media/basic.js';
import { disassemble, listing } from '../../../../transpiler/mos6502.js';
import { lift } from '../../../../transpiler/lift.js';
import { Machine, type CpuState } from '../../../../runtime/mos6502.js';
import { BootstrapFixtureBus } from '../../../../systems/c64.js';
import { systems } from '../../../../systems/index.js';
import { readBounded } from '../../../../files.js';

import { repositoryRoot } from '../../../../paths.js';
export interface Recipe {
  id: string;
  version: number;
  title: string;
  system: string;
  timing: string;
  media: { name: string; sha256: string; boot: boolean }[];
  launch: { file: string; loadAddress: number; entry: number; automatic: boolean };
  bootstrap: {
    bytes: string;
    source: number;
    destination: number;
    length: number;
    instructions: number;
    cycles: number;
  };
  notes: string[];
}
export interface Verification {
  status: 'passed' | 'failed';
  evidence: 'synthetic-bootstrap-fixture';
  hardwareParity: 'unverified';
  gameplay: 'unverified';
  checks: { name: string; passed: boolean; detail: string }[];
  state: CpuState;
  ioWrites: { address: number; value: number }[];
}
function validateRecipe(value: unknown): asserts value is Recipe {
  if (!value || typeof value !== 'object') {
    throw new Diagnostic('RECIPE_SCHEMA', 'Recipe must be a JSON object.');
  }
  const r = value as Recipe;
  if (
    !/^[a-z0-9-]+$/.test(r.id) ||
    !Number.isInteger(r.version) ||
    r.version < 1 ||
    typeof r.title !== 'string' ||
    typeof r.system !== 'string' ||
    !Array.isArray(r.media) ||
    r.media.length < 1 ||
    r.media.length > 16 ||
    !r.launch ||
    !r.bootstrap ||
    !Array.isArray(r.notes)
  ) {
    throw new Diagnostic(
      'RECIPE_SCHEMA',
      'Recipe identity, media, launch or bootstrap fields are invalid.',
    );
  }
  for (const medium of r.media) {
    if (
      !medium ||
      typeof medium !== 'object' ||
      typeof medium.name !== 'string' ||
      basename(medium.name) !== medium.name ||
      medium.name === '.' ||
      medium.name === '..' ||
      !/^[a-f0-9]{64}$/.test(medium.sha256)
    ) {
      throw new Diagnostic('RECIPE_MEDIA', 'Media require a basename and a pinned SHA-256.');
    }
  }
  if (r.media.filter((m) => m.boot === true).length !== 1) {
    throw new Diagnostic('RECIPE_BOOT', 'Recipe must select exactly one boot medium.');
  }
  const numbers = [
    r.launch.entry,
    r.launch.loadAddress,
    r.bootstrap.source,
    r.bootstrap.destination,
    r.bootstrap.length,
  ];
  if (
    numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 65535) ||
    r.bootstrap.length < 1 ||
    r.bootstrap.source + r.bootstrap.length > 65536 ||
    r.bootstrap.destination + r.bootstrap.length > 65536 ||
    !/^(?:[a-f0-9]{2})+$/.test(r.bootstrap.bytes) ||
    r.bootstrap.bytes.length > 512 ||
    r.launch.entry + r.bootstrap.bytes.length / 2 > 65536 ||
    !Number.isInteger(r.bootstrap.instructions) ||
    r.bootstrap.instructions < 1 ||
    r.bootstrap.instructions > 1000000 ||
    !Number.isInteger(r.bootstrap.cycles) ||
    r.bootstrap.cycles < 1 ||
    typeof r.launch.file !== 'string'
  ) {
    throw new Diagnostic(
      'RECIPE_RANGE',
      'Recipe bootstrap addresses, bytes or execution budget are invalid.',
    );
  }
}
export async function runTrial(
  options: { mediaDirectory?: string; recipePath?: string; outputDirectory?: string } = {},
) {
  const recipePath =
    options.recipePath ?? join(repositoryRoot, 'src/games/c64/lemmings/recipe.json');
  const recipeBytes = await readBounded(recipePath, 65536);
  const recipe: unknown = JSON.parse(recipeBytes.toString());
  validateRecipe(recipe);
  const adapter = systems.get(recipe.system);
  if (adapter.timing.id !== recipe.timing) {
    throw new Diagnostic('TIMING_PROFILE', `Unsupported timing '${recipe.timing}'.`);
  }
  if (recipe.id !== 'lemmings-alpha-flight') {
    throw new Diagnostic(
      'MISSING_RECIPE_RUNNER',
      'This version has a bounded bootstrap runner for lemmings-alpha-flight only.',
    );
  }
  const mediaDirectory = resolve(
    options.mediaDirectory ?? join(repositoryRoot, 'roms/c64/lemmings'),
  );
  const media = await Promise.all(
    recipe.media.map(async (input) => {
      const bytes = await readBounded(join(mediaDirectory, input.name), 206114);
      if (sha256(bytes) !== input.sha256) {
        throw new Diagnostic(
          'MEDIA_HASH',
          `SHA-256 mismatch for ${input.name}. Original media were not changed.`,
        );
      }
      return { input, disk: new D64Image(bytes) };
    }),
  );
  const inventory = media.map(({ input, disk }) => ({
    name: input.name,
    sha256: disk.hash,
    boot: input.boot,
    label: disk.name,
    diskId: disk.diskId,
    tracks: disk.tracks,
    entries: disk.entries.map((entry) => {
      const file = disk.extract(entry);
      return {
        ...entry,
        size: file.bytes.length,
        sha256: sha256(file.bytes),
        sectors: file.spans.length,
        blockCountMatches: entry.blocks === file.spans.length,
        provenance: file.spans,
        role: 'unassigned',
      };
    }),
  }));
  const bootDisk = media.find((m) => m.input.boot)!.disk;
  const bootEntries = bootDisk.entries.filter(
    (e) => e.name === recipe.launch.file && e.type === 'PRG',
  );
  if (bootEntries.length !== 1) {
    throw new Diagnostic(
      'BOOT_FILE',
      'Recipe boot PRG must resolve to exactly one directory entry.',
    );
  }
  const boot = bootDisk.extract(bootEntries[0]!);
  const space = new AddressSpace(),
    load = space.loadPrg(boot.bytes, boot.spans);
  if (load.start !== recipe.launch.loadAddress) {
    throw new Diagnostic('LOAD_ADDRESS', 'PRG load address differs from recipe.');
  }
  const launch = basicSys(space.bytes, load.start);
  if (launch.entry !== recipe.launch.entry) {
    throw new Diagnostic('ENTRY_POINT', 'BASIC SYS entry differs from recipe.');
  }
  const expectedBytes = Buffer.from(recipe.bootstrap.bytes, 'hex');
  if (
    !Buffer.from(space.bytes.subarray(launch.entry, launch.entry + expectedBytes.length)).equals(
      expectedBytes,
    )
  ) {
    throw new Diagnostic('BOOTSTRAP_BYTES', 'Reviewed bootstrap bytes differ from the recipe.');
  }
  const cfg = disassemble(space, [launch.entry]);
  const lifted = lift(cfg.instructions);
  const identity = {
    romstudio: VERSION,
    media: recipe.media.map((m) => m.sha256),
    adapter,
    recipe: sha256(recipeBytes),
    timing: recipe.timing,
  };
  const key = sha256(JSON.stringify(identity));
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, 'dist/work/trials', key),
  );
  await mkdir(outputDirectory, { recursive: true });
  // Only the trusted backend emits code. No media bytes or filenames are evaluated.
  const generatedPath = join(outputDirectory, 'bootstrap.js');
  await writeFile(generatedPath, lifted.javascript);
  const generated = (await import(
    `data:text/javascript;base64,${Buffer.from(lifted.javascript).toString('base64')}`
  )) as { step: (machine: Machine) => void };
  const bus = new BootstrapFixtureBus(space.bytes),
    machine = new Machine(bus);
  machine.pc = launch.entry;
  let executionError = '';
  try {
    for (
      let step = 0;
      step < recipe.bootstrap.instructions + 1 && machine.pc !== recipe.bootstrap.destination;
      step++
    ) {
      generated.step(machine);
    }
  } catch (error) {
    executionError = (error as Error).message;
  }
  const { source, destination, length } = recipe.bootstrap;
  const checks: Verification['checks'] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  check(
    'execution',
    !executionError,
    executionError || 'Generated source-address routines executed without an external emulator.',
  );
  check('handoff', machine.pc === destination, `PC=${machine.pc}; expected ${destination}.`);
  check(
    'copy',
    Buffer.from(bus.bytes.subarray(destination, destination + length)).equals(
      space.bytes.subarray(source, source + length),
    ),
    `Compared all ${length} relocated bytes against the original PRG.`,
  );
  check(
    'instructions',
    machine.instructions === recipe.bootstrap.instructions,
    `Observed ${machine.instructions}; expected ${recipe.bootstrap.instructions}.`,
  );
  check(
    'cycles',
    machine.cycles === recipe.bootstrap.cycles,
    `Observed ${machine.cycles}; expected ${recipe.bootstrap.cycles}; excludes hardware stalls.`,
  );
  check(
    'loop-state',
    machine.y === 0 && machine.p === 0x27 && bus.bytes[1] === 0x38,
    'Expected Y=0, P=$27 and fixture processor-port byte=$38.',
  );
  const expectedWrites = [
    { address: 0xd030, value: 255 },
    { address: 0xd030, value: 0 },
    { address: 0xd011, value: 27 },
    { address: 0xd011, value: 13 },
  ];
  check(
    'rmw-writes',
    JSON.stringify(bus.ioWrites) === JSON.stringify(expectedWrites),
    'Verified old-value and result writes for both fixture I/O registers.',
  );
  let unexpectedWrites = 0;
  for (let a = 0; a < 65536; a++) {
    if (a === 1 || (a >= destination && a < destination + length)) {
      continue;
    }
    if (bus.bytes[a] !== space.bytes[a]) {
      unexpectedWrites++;
    }
  }
  check(
    'memory-effects',
    unexpectedWrites === 0,
    `Unexpected changed RAM bytes: ${unexpectedWrites}.`,
  );
  const verification: Verification = {
    status: checks.every((c) => c.passed) ? 'passed' : 'failed',
    evidence: 'synthetic-bootstrap-fixture',
    hardwareParity: 'unverified',
    gameplay: 'unverified',
    checks,
    state: machine.snapshot(),
    ioWrites: bus.ioWrites,
  };
  // Relocation is accepted only after execution has demonstrated the exact copy.
  if (verification.status === 'passed') {
    space.relocate(source, destination, length);
  }
  const relocated =
    verification.status === 'passed'
      ? disassemble(space, [destination])
      : { instructions: [], edges: [], unresolved: [] };
  const manifest = {
    schemaVersion: 1,
    buildId: key,
    title: recipe.title,
    identity,
    build: {
      status: 'partial',
      artifact: 'translated-bootstrap',
      playable: false,
      automaticLaunch: recipe.launch.automatic,
    },
    verification: {
      status: verification.status,
      evidence: verification.evidence,
      hardwareParity: verification.hardwareParity,
      gameplay: verification.gameplay,
    },
    launch: {
      ...recipe.launch,
      expression: launch.expression,
      bootMedium: recipe.media.find((m) => m.boot)!.name,
    },
    coverage: {
      liftedInstructions: cfg.instructions.length,
      observedInstructions: machine.instructions,
      relocatedInstructions: relocated.instructions.length,
      denominator: 'unknown',
    },
    gaps: [
      ...cfg.unresolved.filter((g) => g.address !== destination),
      ...lifted.gaps,
      {
        address: destination,
        kind: 'next-stage',
        detail:
          'Relocated unpacker is decoded but not translated or executed by this bounded trial.',
      },
      {
        kind: 'system-services',
        detail:
          'This bootstrap fixture excludes full C64 hardware. The boot command separately reports the services used by the menu path.',
      },
      {
        kind: 'gameplay',
        detail:
          'This bootstrap build does not execute the menu or gameplay. The boot command covers menu startup; level data, skills, completion and disk transitions remain incomplete.',
      },
      {
        kind: 'reference-evidence',
        detail: 'Synthetic CPU fixture only; no hardware trace or gameplay parity evidence.',
      },
    ],
    assets: {
      policy: 'local-only',
      publicAssets: [],
      mediaRequired: recipe.media.map((m) => m.name),
    },
    profile: adapter.web,
    notes: recipe.notes,
  };
  const json = (file: string, value: unknown): Promise<void> =>
    writeFile(join(outputDirectory, file), JSON.stringify(value, null, 2) + '\n');
  await Promise.all([
    json('manifest.json', manifest),
    json('inventory.json', inventory),
    json('verification.json', verification),
    json('control-flow.json', cfg),
    json('relocated-control-flow.json', relocated),
    json('source-map.json', lifted.mappings),
    writeFile(join(outputDirectory, 'bootstrap.asm'), listing(cfg.instructions)),
    writeFile(join(outputDirectory, 'relocated.asm'), listing(relocated.instructions)),
    writeFile(join(outputDirectory, 'bootstrap.ts'), lifted.typescript),
    copyFile(
      fileURLToPath(new URL('../../../../runtime/mos6502.js', import.meta.url)),
      join(outputDirectory, 'runtime.js'),
    ),
    copyFile(
      fileURLToPath(new URL('../../../../runtime/mos6502.d.ts', import.meta.url)),
      join(outputDirectory, 'runtime.d.ts'),
    ),
  ]);
  return { outputDirectory, manifest, verification, inventory };
}
