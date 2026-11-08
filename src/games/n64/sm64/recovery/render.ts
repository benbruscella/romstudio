import { Diagnostic, sha256 } from '../../../../core.js';
import type { N64System } from '../../../../systems/n64/system.js';
import type { RspMachine } from '../../../../runtime/rsp.js';
import { renderN64ColorImage } from '../../../../systems/n64/render.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';
import { importStaticProgram } from '../../../../transpiler/program.js';
import { cloneGraphicsFixture } from './task-fixture.js';

function finish(system: N64System): void {
  while (!(system.memory.signal.status & 1) && system.ticks < 1000000) {
    system.advanceClock();
  }
  if ((system.memory.signal.status & 0x203) !== 0x203 || system.memory.signal.read(0x18) !== 0) {
    throw new Diagnostic(
      'SM64_RENDER_TASK',
      'The original textured task did not finish its DMA, signal and BREAK.',
    );
  }
}

/** Original Fast3D words produce actual framebuffer/depth pixels. Static
 * replay checks the same renderer; hardware pixel parity stays unverified. */
export async function verifySm64RenderedTask(input: N64System) {
  const native = cloneGraphicsFixture(input),
    recovery = new RspRecovery('first-textured-task-render');
  native.enableRsp(recovery.step);
  finish(native);
  const program = recovery.emit(),
    compiled = await importStaticProgram<RspMachine>(program),
    replay = cloneGraphicsFixture(input);
  replay.enableRsp(compiled.step);
  finish(replay);
  const image = native.memory.display.colorImage,
    rgba = renderN64ColorImage(native.memory.ram.bytes, image, 240);
  if (image.width !== 320) {
    throw new Diagnostic('SM64_RENDER_IMAGE', 'Expected the pinned 320-pixel color image.');
  }
  const depthAddress = native.memory.display.stateWords[125]! & 0x3ffffff;
  const replayRgba = renderN64ColorImage(
    replay.memory.ram.bytes,
    replay.memory.display.colorImage,
    240,
  );
  const lit = Array.from(
    { length: 320 * 240 },
    (_, i) => rgba[i * 4]! | rgba[i * 4 + 1]! | rgba[i * 4 + 2]!,
  ).filter(Boolean).length;
  const checks = [
    {
      name: 'render-original-vs-static-rsp',
      passed: JSON.stringify(native.rsp.snapshot()) === JSON.stringify(replay.rsp.snapshot()),
    },
    {
      name: 'render-original-vs-static-rdram',
      passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
    },
    {
      name: 'render-original-vs-static-sp-memory',
      passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
    },
    {
      name: 'render-original-vs-static-devices',
      passed: JSON.stringify(native.snapshot()) === JSON.stringify(replay.snapshot()),
    },
    { name: 'render-original-vs-static-pixels', passed: sha256(rgba) === sha256(replayRgba) },
    {
      name: 'render-task-done-and-full-sync',
      passed:
        native.memory.display.fullSyncs === input.memory.display.fullSyncs + 1 &&
        (native.memory.interrupts.pending & 33) === 33,
    },
    {
      name: 'render-pixels-and-depth-written',
      passed:
        native.memory.display.triangles.length > 0 &&
        native.memory.display.pixels.written > 0 &&
        lit > 0 &&
        sha256(native.memory.ram.bytes.subarray(depthAddress, depthAddress + 320 * 240 * 2)) !==
          sha256(input.memory.ram.bytes.subarray(depthAddress, depthAddress + 320 * 240 * 2)),
    },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_RENDER_PARITY', JSON.stringify(checks));
  }
  return {
    program,
    mappings: recovery.observations,
    rgba,
    report: {
      status: 'first-textured-task-rendered' as const,
      fixture: {
        cpu: 'paused at the first textured graphics start callback',
        clock: 'fresh-functional-device-clock',
        inputRdram: sha256(input.memory.ram.bytes),
        inputSpMemory: sha256(input.memory.signal.memory),
      },
      verification: {
        referenceReplay: 'passed',
        hardwareParity: 'unverified',
        gameplay: 'unverified',
        pixelPrecision: 'functional-approximation',
        checks,
      },
      instructions: native.rsp.instructions - input.rsp.instructions,
      shapes: recovery.shapeCount,
      ticks: native.ticks,
      image: { ...image, height: 240, nonblackPixels: lit, rgbaSha256: sha256(rgba) },
      display: native.memory.display.snapshot(),
      state: native.rsp.snapshot(),
    },
  };
}
