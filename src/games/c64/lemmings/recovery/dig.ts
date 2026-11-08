import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { runLevelToFirstSpawn, type LevelOptions } from './level.js';
import { recover } from '../../../../transpiler/recover.js';
import { disassemble, listing } from '../../../../transpiler/mos6502.js';
import { AddressSpace } from '../../../../memory.js';
import { decodeLevelHeader, decodeTerrain } from '../code/level-data.js';
import { assignDigger, readLemming, readSkillStock, updateDiggerStroke } from '../code/digger.js';
import { encodePng } from '../../../../png.js';

export interface DiggerInput {
  frame: number;
  joystick: number;
  key8: boolean;
}
export interface DigOptions extends Omit<LevelOptions, 'level'> {
  inputReplay?: readonly DiggerInput[];
}

/** An original-input analysis replay. The named functions run in a shadow copy
 * for comparison; the original instructions make every authoritative change. */
export async function digTrial(options: DigOptions = {}) {
  if (options.inputReplay !== undefined && !Array.isArray(options.inputReplay)) {
    throw new Diagnostic('DIGGER_INPUT', 'Input replay must be an array.');
  }
  if (
    options.inputReplay?.some(
      (input, index, inputs) =>
        !input ||
        typeof input !== 'object' ||
        !Number.isInteger(input.frame) ||
        input.frame < 1 ||
        input.frame > 10000 ||
        (index > 0 && input.frame <= inputs[index - 1]!.frame) ||
        !Number.isInteger(input.joystick) ||
        input.joystick < 0 ||
        input.joystick > 255 ||
        typeof input.key8 !== 'boolean',
    ) ||
    (options.inputReplay?.length ?? 0) > 10000
  ) {
    throw new Diagnostic(
      'DIGGER_INPUT',
      'Input replay needs ordered, bounded control frames, joystick bytes and key states.',
    );
  }
  const runtime = await runLevelToFirstSpawn({ ...options, level: 1 });
  const { bus, machine, title, trial } = runtime;
  if (runtime.result.stop !== 'checkpoint') {
    throw new Diagnostic(
      'DIGGER_START',
      `First spawn failed: ${JSON.stringify(runtime.result.gap)}.`,
    );
  }
  const initialMemory = bus.bytes.slice(),
    initialKnown = bus.known.slice();
  const header = decodeLevelHeader(bus),
    before = decodeTerrain(bus);
  const inputs: DiggerInput[] = [];
  const strokes: {
    tick: number;
    index: number;
    before: ReturnType<typeof readLemming>;
    result: ReturnType<typeof updateDiggerStroke>;
    passed: boolean;
    differences: number[];
  }[] = [];
  const assignments: {
    tick: number;
    index: number;
    before: ReturnType<typeof readLemming>;
    result: ReturnType<typeof assignDigger>;
    passed: boolean;
  }[] = [];
  let ticks = 0,
    frames = 0,
    sentFire = false,
    replayIndex = 0;
  let currentInput: DiggerInput = { frame: 0, joystick: 255, key8: false };
  let pendingStroke:
    | {
        memory: { bytes: Uint8Array; known: Uint8Array };
        entry: Omit<(typeof strokes)[number], 'passed' | 'differences'>;
      }
    | undefined;
  let pendingAssignment: Omit<(typeof assignments)[number], 'passed'> | undefined;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const result = recover(machine, {
    stopAt: 0xffff,
    stopWhen: () => ticks >= 200,
    maxInstructions: 12000000,
    maxVariants: 30000,
    maxBoundaryOperations: 100000,
    onFetch: (instruction) => bus.observe(instruction),
    onBoundary: (s) => {
      if (s.pc === 0xe39) {
        ticks++;
      }
      if (s.pc === 0x16d3) {
        frames++;
        let next: DiggerInput;
        if (options.inputReplay) {
          if (options.inputReplay[replayIndex]?.frame === frames) {
            currentInput = options.inputReplay[replayIndex++]!;
          }
          next = { ...currentInput, frame: frames };
        } else {
          const actor = readLemming(bus, 0),
            cursorX = bus.bytes[0xb6]!,
            cursorY = bus.bytes[0xb8]!;
          const scroll = (bus.bytes[0x40d]! << 2) | (bus.bytes[0x40c]! >>> 1);
          const targetX = actor.x - 1 - scroll,
            targetY = actor.y + 6;
          let joystick = 255;
          if (!sentFire) {
            if (targetX > cursorX + 1) {
              joystick &= ~8;
            } else if (targetX < cursorX - 1) {
              joystick &= ~4;
            }
            if (targetY > cursorY + 1) {
              joystick &= ~2;
            } else if (targetY < cursorY - 1) {
              joystick &= ~1;
            }
            if (
              bus.bytes[0x5c1] === 0 &&
              (actor.mode & 31) === 8 &&
              Math.abs(targetX - cursorX) <= 3 &&
              Math.abs(targetY - cursorY) <= 4
            ) {
              joystick &= ~16;
              sentFire = true;
            }
          }
          next = { frame: frames, joystick, key8: !sentFire && bus.bytes[0x5c0] !== 7 };
        }
        if (
          next.joystick !== currentInput.joystick ||
          next.key8 !== currentInput.key8 ||
          frames === 1 ||
          options.inputReplay?.[replayIndex - 1]?.frame === frames
        ) {
          inputs.push(next);
        }
        currentInput = next;
        bus.cia1.inputA = next.joystick;
        bus.cia1.setKey(3, 3, next.key8); // Original scan table: key 8, PA3/PB3.
      }
      if (s.pc === 0x164c) {
        const index = s.y,
          before = readLemming(bus, index);
        pendingAssignment = {
          tick: ticks,
          index,
          before,
          result: assignDigger(before, readSkillStock(bus, 7)),
        };
      }
      if (s.pc === 0x153b && pendingAssignment) {
        const entry = pendingAssignment;
        assignments.push({
          ...entry,
          passed:
            same(entry.result.actor, readLemming(bus, entry.index)) &&
            entry.result.stock === readSkillStock(bus, 7),
        });
        pendingAssignment = undefined;
      }
      if (s.pc === 0x244a) {
        const index = bus.bytes[0x5c5]!,
          before = { ...readLemming(bus, index), mode: bus.bytes[0x5c6]! };
        const memory = { bytes: bus.bytes.slice(), known: bus.known.slice() };
        pendingStroke = {
          memory,
          entry: { tick: ticks, index, before, result: updateDiggerStroke(memory, before) },
        };
      }
      if (s.pc === 0x1ef0 && pendingStroke) {
        const { memory, entry } = pendingStroke;
        const actual = { ...readLemming(bus, entry.index), mode: bus.bytes[0x5c6]! };
        const differences: number[] = [];
        for (let address = 0x6000; address < 0xb400; address++) {
          if (address >= 0x7000 && address < 0x8000) {
            continue;
          }
          if (memory.bytes[address] !== bus.bytes[address]) {
            differences.push(address);
          }
        }
        strokes.push({
          ...entry,
          passed:
            !differences.length &&
            same(entry.result.actor, actual) &&
            entry.result.movementIndex === s.y,
          differences,
        });
        pendingStroke = undefined;
      }
      return title.boundary(s);
    },
  });
  bus.cia1.inputA = 255;
  bus.cia1.setKey(3, 3, false);
  const after = decodeTerrain(bus);
  const changes: { x: number; y: number; before: number; after: number }[] = [];
  before.pairs.forEach((pair, index) => {
    if (pair !== after.pairs[index]) {
      changes.push({
        x: index % before.width,
        y: Math.floor(index / before.width) + before.originY,
        before: pair,
        after: after.pairs[index]!,
      });
    }
  });
  const checks = [
    { name: 'bounded-original-input-run', passed: result.stop === 'checkpoint' && ticks === 200 },
    {
      name: 'trainers-disabled',
      passed:
        bus.bytes[0xcffc] === 0 &&
        title.inputs.filter((input) => input.kind === 'trainer-no').length === 12,
    },
    {
      name: 'one-digger-assigned',
      passed: assignments.length === 1 && assignments[0]!.result.assigned && assignments[0]!.passed,
    },
    {
      name: 'stock-ten-to-nine',
      passed: header.skillStockBySlot[7] === 10 && readSkillStock(bus, 7) === 9,
    },
    {
      name: 'native-stroke-comparisons',
      passed:
        strokes.length > 0 &&
        strokes.every((stroke) => stroke.passed) &&
        !pendingStroke &&
        !pendingAssignment,
    },
    {
      name: 'terrain-removed',
      passed:
        changes.length > 0 && changes.every((change) => change.before !== 0 && change.after === 0),
    },
    { name: 'digger-returned-to-walking', passed: (readLemming(bus, 0).mode & 31) === 8 },
    {
      name: 'input-replay-consumed',
      passed: !options.inputReplay || replayIndex === options.inputReplay.length,
    },
  ];
  const passed = checks.every((check) => check.passed);
  const key = sha256(
    JSON.stringify({
      buildId: trial.manifest.buildId,
      stage: 'digger-stroke-v1',
      inputs,
      replay: !!options.inputReplay,
    }),
  );
  const directory = join(trial.outputDirectory, `dig-${key}`);
  await mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    buildId: trial.manifest.buildId,
    digId: key,
    status: passed ? 'digger-path-verified' : 'partial',
    build: { status: 'partial', artifact: 'recovered-digger-analysis', playable: false },
    verification: {
      diggerPath: passed ? 'passed' : 'failed',
      hardwareParity: 'unverified',
      fullGameplay: 'unverified',
      checks,
    },
    stop: result.stop,
    gap: result.gap,
    state: result.state,
    header,
    ticks,
    controlFrames: frames,
    inputs,
    inputMode: options.inputReplay ? 'recorded-replay' : 'cursor-controller',
    assignment: assignments,
    strokeComparisons: {
      count: strokes.length,
      passed: strokes.filter((stroke) => stroke.passed).length,
    },
    terrainChanges: changes,
    skillStock: readSkillStock(bus, 7),
    firstLemming: readLemming(bus, 0),
    hashes: {
      beforeTerrain: sha256(before.pairs),
      afterTerrain: sha256(after.pairs),
      memory: sha256(bus.bytes),
      knownMemory: sha256(bus.known),
      inputs: sha256(JSON.stringify(inputs)),
    },
    diskReads: title.diskReads,
    limitations: [
      'Original instructions remain authoritative; named routines are checked in shadow memory for game-state and terrain effects, not CPU flags or timing.',
      'This replay checks one assignment and ordinary first-level digging. Special terrain, other skills and full level completion remain unverified.',
      'Input is supplied through CIA keyboard switches and joystick pins. Cursor and entity positions are never directly set by the controller.',
      'The level launch fixtures, approximate PAL services, incomplete raster rendering and absent SID synthesis still apply. No playable browser slice is exported.',
    ],
    assets: { policy: 'local-only', publicAssets: [] },
  };
  const space = new AddressSpace();
  space.bytes.set(bus.bytes);
  space.loaded.set(bus.known);
  const cfg = disassemble(space, [0x1501, 0x164c, 0x244a, 0x2930], 2048);
  await Promise.all([
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(directory, 'input-replay.json'), JSON.stringify(inputs, null, 2) + '\n'),
    writeFile(join(directory, 'stroke-checks.json'), JSON.stringify(strokes, null, 2) + '\n'),
    writeFile(join(directory, 'digger.asm'), listing(cfg.instructions)),
    writeFile(join(directory, 'memory-before.bin'), initialMemory),
    writeFile(join(directory, 'known-memory-before.bin'), initialKnown),
    writeFile(join(directory, 'memory.bin'), bus.bytes),
    writeFile(join(directory, 'known-memory.bin'), bus.known),
    writeFile(join(directory, 'terrain-before.png'), encodePng(640, 153, before.pixels)),
    writeFile(join(directory, 'terrain-after.png'), encodePng(640, 153, after.pixels)),
  ]);
  return { outputDirectory: directory, report };
}
