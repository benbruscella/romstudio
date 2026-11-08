import { Diagnostic, sha256 } from '../../../../core.js';
import { Vr4300Gap } from '../../../../runtime/vr4300.js';
import type { RspMachine } from '../../../../runtime/rsp.js';
import type { N64System } from '../../../../systems/n64/system.js';
import { rdpCommandBytes } from '../../../../systems/n64/display.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';
import { importStaticProgram } from '../../../../transpiler/program.js';
import { cloneGraphicsFixture } from './task-fixture.js';

function reachTriangle(system: N64System) {
  // Keep this earlier study reproducible as rendering support grows. This is
  // an explicit draw breakpoint, rather than an unsupported-command failure.
  system.memory.display.beforeDraw = (command) => {
    if (command.opcode >= 8 && command.opcode <= 15) {
      throw new Vr4300Gap('rdp-triangle', 0, command.address, 'First triangle draw breakpoint.');
    }
  };
  try {
    while ((system.memory.signal.status & 1) === 0 && system.ticks < 1000000) {
      system.advanceClock();
    }
  } catch (error) {
    if (!(error instanceof Vr4300Gap) || error.kind !== 'rdp-triangle') {
      throw error;
    }
    const address = error.address,
      high = system.memory.ram.read32(address),
      opcode = (high >>> 24) & 63;
    return {
      kind: error.kind,
      address,
      opcode,
      bytes: [...system.memory.ram.bytes.subarray(address, address + rdpCommandBytes(opcode))],
      rspAddress: system.rsp.pc,
      taskComplete: false,
    };
  } finally {
    system.memory.display.beforeDraw = undefined;
  }
  throw new Diagnostic(
    'SM64_TEXTURE_BOUNDARY',
    'Expected the first complete textured triangle packet before task completion or the budget.',
  );
}

/** Recover a bounded graphics prefix without pretending the unsupported
 * triangle was drawn. Native and static runs must stop at the same packet. */
export async function verifySm64TexturePrefix(input: N64System) {
  const recovery = new RspRecovery('first-textured-triangle-prefix'),
    native = cloneGraphicsFixture(input);
  native.enableRsp(recovery.step);
  const boundary = reachTriangle(native),
    program = recovery.emit();
  const compiled = await importStaticProgram<RspMachine>(program),
    replay = cloneGraphicsFixture(input);
  replay.enableRsp(compiled.step);
  const replayBoundary = reachTriangle(replay);
  const texture = native.memory.display.texture,
    load = texture.loads.at(-1),
    tile = texture.tiles[0]!;
  if (
    boundary.opcode !== 15 ||
    !load ||
    load.tile !== 7 ||
    load.bytes !== 2048 ||
    tile.size !== 2 ||
    tile.format !== 0 ||
    tile.line !== 8 ||
    tile.sl !== 0 ||
    tile.tl !== 0 ||
    tile.sh !== 124 ||
    tile.th !== 124
  ) {
    throw new Diagnostic(
      'SM64_TEXTURE_FIXTURE',
      'Expected the pinned first RGBA16 32 × 32 load and shaded/textured/depth triangle.',
    );
  }
  const rgba = new Uint8Array(32 * 32 * 4);
  let texelsMatch = true;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const pixel = texture.sample(0, x * 32, y * 32),
        original = input.memory.ram.read16(load.source + (y * 32 + x) * 2);
      // Independent direct source-image decode: no TMEM bank addressing,
      // texture descriptor or sampling code participates in the expectation.
      const expected = [0, 0, 0, (original & 1) * 255];
      // RGBA5 expansion replicates the high bits into the low three bits.
      for (let c = 0; c < 3; c++) {
        const five = (original >>> (11 - c * 5)) & 31;
        expected[c] = five * 8 + Math.floor(five / 4);
      }
      if (pixel.some((value, c) => value !== expected[c])) {
        texelsMatch = false;
      }
      rgba.set(pixel, (y * 32 + x) * 4);
    }
  }
  const checks = [
    {
      name: 'texture-original-vs-static-boundary',
      passed: JSON.stringify(boundary) === JSON.stringify(replayBoundary),
    },
    {
      name: 'texture-original-vs-static-rsp',
      passed: JSON.stringify(native.rsp.snapshot()) === JSON.stringify(replay.rsp.snapshot()),
    },
    {
      name: 'texture-original-vs-static-rdram',
      passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
    },
    {
      name: 'texture-original-vs-static-sp-memory',
      passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
    },
    {
      name: 'texture-original-vs-static-devices',
      passed: JSON.stringify(native.snapshot()) === JSON.stringify(replay.snapshot()),
    },
    { name: 'texture-all-1024-texels-match-source', passed: texelsMatch },
    {
      name: 'texture-triangle-remains-unconsumed',
      passed:
        native.memory.display.current === boundary.address &&
        (native.memory.signal.status & 1) === 0 &&
        native.memory.display.fullSyncs === input.memory.display.fullSyncs,
    },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_TEXTURE_PARITY', JSON.stringify(checks));
  }
  return {
    program,
    mappings: recovery.observations,
    rgba,
    report: {
      status: 'first-textured-triangle-reached' as const,
      fixture: {
        cpu: 'paused at the first textured graphics start callback',
        initialRspRegisters: 'retained from preceding original tasks',
        clock: 'fresh-functional-device-clock',
        inputRdram: sha256(input.memory.ram.bytes),
        inputSpMemory: sha256(input.memory.signal.memory),
      },
      verification: {
        referenceReplay: 'passed',
        hardwareParity: 'unverified',
        gameplay: 'unverified',
        checks,
      },
      instructions: native.rsp.instructions - input.rsp.instructions,
      shapes: recovery.shapeCount,
      ticks: native.ticks,
      boundary,
      texture: {
        width: 32,
        height: 32,
        texels: 1024,
        source: load.source,
        tile: 0,
        rgbaSha256: sha256(rgba),
      },
      display: native.memory.display.snapshot(),
      state: native.rsp.snapshot(),
    },
  };
}
