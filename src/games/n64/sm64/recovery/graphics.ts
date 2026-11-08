import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Diagnostic, sha256 } from '../../../../core.js';
import { gameBuildDirectory } from '../../../../paths.js';
import type { StartupOptions } from '../../../../startup.js';
import type { N64System } from '../../../../systems/n64/system.js';
import type { RspMachine } from '../../../../runtime/rsp.js';
import { Vr4300Gap, type Vr4300Machine } from '../../../../runtime/vr4300.js';
import { compileVr4300, decodeVr4300 } from '../../../../transpiler/vr4300.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';
import { importStaticProgram, writeStaticProgram } from '../../../../transpiler/program.js';
import { bootSm64 } from './boot.js';
import { cloneGraphicsFixture } from './task-fixture.js';
import { verifySm64TexturePrefix } from './textures.js';
import { verifySm64RenderedTask } from './render.js';
import { encodePng } from '../../../../png.js';

function finishTask(system: N64System): void {
  while ((system.memory.signal.status & 1) === 0 && system.ticks < 100000) {
    system.advanceClock();
  }
  if ((system.memory.signal.status & 0x203) !== 0x203 || system.memory.signal.read(0x18) !== 0) {
    throw new Diagnostic(
      'SM64_GRAPHICS_TASK',
      'The first graphics task did not complete its DMA, task-done signal and BREAK within budget.',
    );
  }
}

/** Verify original RSP words, emitted static code and actual RDP framebuffer
 * writes. The whole later CPU capture is exploratory, separately labelled. */
export async function verifySm64GraphicsTask(input: N64System) {
  if (input.memory.signal.view.getUint32(0xfc0, false) !== 1) {
    throw new Diagnostic('SM64_GRAPHICS_TASK', 'Expected the original graphics task descriptor.');
  }
  const recovery = new RspRecovery('first-graphics-task');
  const native = cloneGraphicsFixture(input);
  native.enableRsp(recovery.step);
  finishTask(native);
  const program = recovery.emit();
  const compiled = await importStaticProgram<RspMachine>(program);
  const replay = cloneGraphicsFixture(input);
  replay.enableRsp(compiled.step);
  finishTask(replay);
  const checks = [
    {
      name: 'graphics-original-vs-static-rsp',
      passed: JSON.stringify(native.rsp.snapshot()) === JSON.stringify(replay.rsp.snapshot()),
    },
    {
      name: 'graphics-original-vs-static-rdram',
      passed: sha256(native.memory.ram.bytes) === sha256(replay.memory.ram.bytes),
    },
    {
      name: 'graphics-original-vs-static-sp-memory',
      passed: sha256(native.memory.signal.memory) === sha256(replay.memory.signal.memory),
    },
    {
      name: 'graphics-original-vs-static-devices',
      passed: JSON.stringify(native.snapshot()) === JSON.stringify(replay.snapshot()),
    },
    {
      name: 'graphics-full-sync-and-sp-interrupts',
      passed:
        native.memory.display.fullSyncs === input.memory.display.fullSyncs + 1 &&
        (native.memory.interrupts.pending & 33) === 33,
    },
    {
      name: 'graphics-rdp-range-consumed',
      passed: native.memory.display.current === native.memory.display.end,
    },
    {
      name: 'graphics-frame-and-depth-writes',
      passed:
        native.memory.display.fills.length >= 2 &&
        sha256(native.memory.ram.bytes) !== sha256(input.memory.ram.bytes),
    },
  ];
  if (checks.some((check) => !check.passed)) {
    throw new Diagnostic('SM64_GRAPHICS_PARITY', JSON.stringify(checks));
  }
  return {
    program,
    mappings: recovery.observations,
    report: {
      status: 'first-graphics-clear-task-completed' as const,
      fixture: {
        cpu: 'paused at the first graphics start callback',
        initialRspRegisters: 'retained from the preceding original audio task',
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
      display: native.memory.display.snapshot(),
      state: native.rsp.snapshot(),
    },
  };
}

/** Continue the verified CPU checkpoint using original CPU/RSP instructions.
 * Capture the next processor handoff; no game functions are substituted. */
export async function bootSm64Graphics(
  options: StartupOptions & {
    onProgress?: (message: string) => void;
    stage?: 'clear' | 'textures' | 'frame';
  } = {},
) {
  const frame = options.stage === 'frame';
  const textures = options.stage === 'textures' || frame;
  const outputDirectory = resolve(
    options.outputDirectory ??
      join(
        gameBuildDirectory('n64/sm64'),
        frame ? 'analysis/render' : textures ? 'analysis/textures' : 'analysis/graphics',
      ),
  );
  options.onProgress?.('Verifying CPU startup and the first original audio task…');
  const startup = await bootSm64({
    ...options,
    ...(options.outputDirectory ? { outputDirectory: join(outputDirectory, 'startup') } : {}),
  });
  const native = startup.checkpoint,
    audio = new RspRecovery('coupled-startup-audio');
  const cpuShapes = new Map<number, { word: number; operation: (cpu: Vr4300Machine) => void }>();
  let input: N64System | undefined, firstInput: N64System | undefined;
  native.enableRsp(audio.step);
  if (textures) {
    native.memory.display.beforeDraw = (command) => {
      if (command.opcode >= 8 && command.opcode <= 15) {
        throw new Vr4300Gap('rdp-triangle', 0, command.address, 'First triangle draw breakpoint.');
      }
    };
  }
  const onStart = native.memory.signal.onStart!;
  let capture: { cpuInstruction: number; ticks: number; cpuAddress: number } | undefined;
  native.memory.signal.onStart = () => {
    onStart();
    if ((!input || textures) && native.memory.signal.view.getUint32(0xfc0, false) === 1) {
      input = cloneGraphicsFixture(native);
      firstInput ??= input;
      capture = {
        cpuInstruction: native.cpu.instructions,
        ticks: native.ticks,
        cpuAddress: native.cpu.pc,
      };
    }
  };
  options.onProgress?.(
    textures
      ? 'Following original CPU/RSP execution to its first textured triangle…'
      : 'Following original CPU/RSP startup to its first graphics task…',
  );
  let nextProgress = native.ticks + 30000000;
  const cpuStep = (cpu: Vr4300Machine) => {
    const word = cpu.bus.read32(cpu.pc);
    let shape = cpuShapes.get(cpu.pc);
    if (!shape || shape.word !== word) {
      shape = { word, operation: compileVr4300(decodeVr4300(word, cpu.pc)) };
      cpuShapes.set(cpu.pc, shape);
    }
    shape.operation(cpu);
  };
  let triangleReached = false;
  while ((!input || textures) && native.ticks < (textures ? 360000000 : 300000000)) {
    try {
      if (!native.advanceIdle((textures ? 360000000 : 300000000) - native.ticks)) {
        native.step(cpuStep);
      }
    } catch (error) {
      if (!textures || !(error instanceof Vr4300Gap) || error.kind !== 'rdp-triangle') {
        throw error;
      }
      triangleReached = true;
      break;
    }
    if (native.ticks >= nextProgress) {
      options.onProgress?.(
        `${native.cpu.instructions.toLocaleString()} CPU instructions; ${native.memory.signal.breaks} completed RSP tasks.`,
      );
      nextProgress += 30000000;
    }
  }
  if (!input || (textures && !triangleReached)) {
    throw new Diagnostic(
      'SM64_GRAPHICS_BUDGET',
      'The original CPU/RSP execution did not reach the requested graphics stage within budget.',
    );
  }
  options.onProgress?.(
    frame
      ? 'Comparing original/static RSP execution and rendered framebuffer/depth writes…'
      : textures
        ? 'Comparing static RSP replay and all 1,024 texture samples through the first triangle boundary…'
        : 'Verifying the captured graphics task and RDP writes with fresh static replay…',
  );
  const graphics = frame
    ? await verifySm64RenderedTask(input)
    : textures
      ? await verifySm64TexturePrefix(input)
      : await verifySm64GraphicsTask(input);
  const firstGraphics = textures ? await verifySm64GraphicsTask(firstInput!) : undefined;
  const firstTexture = frame ? await verifySm64TexturePrefix(input) : undefined;
  const report = {
    status: graphics.report.status,
    media: startup.report.media,
    cpuStartupVerification: startup.report.verification,
    audioVerification: startup.report.audio.verification,
    capture: {
      ...capture,
      referenceReplayAfterFirstAudioRequest: 'unverified',
      scope: frame
        ? 'Original CPU/RSP capture remains exploratory; the isolated original textured task and pixel output pass static replay. Hardware pixel precision and gameplay remain unverified.'
        : textures
          ? 'Original CPU/RSP recovery captures a real handoff; only the isolated prefix through texture loading is statically replayed. The triangle remains unrendered and the task incomplete.'
          : 'Original CPU/RSP recovery captures a real handoff; only the isolated graphics task is statically replayed at this stage.',
    },
    verification: graphics.report.verification,
    graphics: graphics.report,
    ...(firstGraphics ? { firstGraphics: firstGraphics.report } : {}),
    ...(firstTexture ? { firstTexture: firstTexture.report } : {}),
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeStaticProgram(graphics.program, outputDirectory);
  await writeFile(join(outputDirectory, 'rdram.bin'), input.memory.ram.bytes);
  await writeFile(join(outputDirectory, 'sp-memory.bin'), input.memory.signal.memory);
  if ('rgba' in graphics) {
    await writeFile(
      join(outputDirectory, frame ? 'first-frame.png' : 'first-texture.png'),
      encodePng(frame ? 320 : 32, frame ? 240 : 32, graphics.rgba),
    );
  }
  if (firstTexture) {
    await writeFile(
      join(outputDirectory, 'first-texture.png'),
      encodePng(32, 32, firstTexture.rgba),
    );
  }
  for (const [name, state] of [
    ['rsp', input.rsp.snapshot()],
    ['signal', input.memory.signal.snapshot()],
    ['display', input.memory.display.snapshot()],
    ['report', report],
  ] as const) {
    await writeFile(join(outputDirectory, name + '.json'), JSON.stringify(state, null, 2) + '\n');
  }
  const studyDirectory = join(startup.outputDirectory, 'source-study');
  const manifest = JSON.parse(await readFile(join(studyDirectory, 'manifest.json'), 'utf8')) as {
    files: Record<string, string>;
    exportId: string;
    verification: Record<string, unknown>;
  };
  const sourceFolder = frame ? 'rsp-render' : textures ? 'rsp-textures' : 'rsp-graphics';
  const files: Record<string, string> = {
    [`game-code/${sourceFolder}/program.ts`]: graphics.program.typescript,
    [`game-code/${sourceFolder}/observed-source.json`]:
      JSON.stringify(
        {
          schemaVersion: 1,
          architecture: 'n64-rsp',
          scope: frame
            ? 'First original textured graphics task, captured after exploratory CPU recovery and checked by isolated static RSP/framebuffer replay. Rasterization, filtering, perspective, depth and blending use a declared functional approximation; independent hardware pixel parity and gameplay remain unverified.'
            : textures
              ? 'Original textured graphics prefix, captured after exploratory CPU recovery and verified in a paused-CPU fixture. All 1,024 texels agree with the source image. The first triangle remains unrendered and the task incomplete.'
              : 'First original buffer-clear task, captured after exploratory CPU recovery and verified in a paused-CPU fixture. The separate rendered-task study covers triangles; hardware precision and gameplay remain unverified.',
          mappings: graphics.mappings,
        },
        null,
        2,
      ) + '\n',
  };
  if (firstGraphics) {
    files['game-code/rsp-graphics/program.ts'] = firstGraphics.program.typescript;
    files['game-code/rsp-graphics/observed-source.json'] =
      JSON.stringify(
        {
          schemaVersion: 1,
          architecture: 'n64-rsp',
          scope:
            'First original buffer-clear task; isolated original/static replay. CPU capture after the first audio request remains exploratory.',
          mappings: firstGraphics.mappings,
        },
        null,
        2,
      ) + '\n';
    manifest.verification.rspGraphics = firstGraphics.report.verification;
  }
  if (firstTexture) {
    files['game-code/rsp-textures/program.ts'] = firstTexture.program.typescript;
    files['game-code/rsp-textures/observed-source.json'] =
      JSON.stringify(
        {
          schemaVersion: 1,
          architecture: 'n64-rsp',
          scope:
            'Original vertex/texture prefix, stopped at an explicit draw breakpoint before the first triangle. Isolated static replay and all 1,024 texture samples pass; task completion and gameplay are outside this prefix.',
          mappings: firstTexture.mappings,
        },
        null,
        2,
      ) + '\n';
    manifest.verification.rspTextures = firstTexture.report.verification;
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(studyDirectory, 'game-code', name.split('/')[1]!), { recursive: true });
    await writeFile(join(studyDirectory, name), text);
    manifest.files[name] = sha256(text);
  }
  manifest.verification[frame ? 'rspRender' : textures ? 'rspTextures' : 'rspGraphics'] =
    graphics.report.verification;
  manifest.exportId = sha256(JSON.stringify(manifest.files));
  await writeFile(join(studyDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outputDirectory, report, checkpoint: native };
}
