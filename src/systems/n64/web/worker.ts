import { N64Player } from '../player.js';
import type { Vr4300Block } from '../system.js';
import type { N64Launch } from '../checkpoint.js';
import type { Vr4300Machine, Vr4300Program } from '../../../runtime/vr4300.js';
import type { RspMachine, RspProgram } from '../../../runtime/rsp.js';
import { clearN64Trace } from '../checkpoint.js';
import { describeTick, n64DeskRead, n64DeskState } from './desk.js';
import type {
  N64DeskRequest,
  N64ExecutionTier,
  N64RdpReply,
  N64RdpRequest,
  N64WorkerRequest,
  N64WorkerReply,
} from './protocol.js';

const port = globalThis as unknown as {
  onmessage: (event: MessageEvent<N64WorkerRequest>) => void;
  postMessage(message: N64WorkerReply, transfer?: Transferable[]): void;
};
let player: N64Player | undefined,
  running = false,
  scheduled = false;
let assets:
  | {
      launch: N64Launch;
      rom: Uint8Array;
      ram: Uint8Array;
      signal: Uint8Array;
      cpu: (s: Vr4300Machine) => void;
      rsp: (s: RspMachine) => void;
      linear: RspProgram['prepareLinear'];
      local: RspProgram['runLocal'];
      idleAddresses: Vr4300Program['idleAddresses'];
      tier: N64ExecutionTier;
      blocks: ReadonlyMap<number, Vr4300Block> | undefined;
    }
  | undefined;
let previousFrame = 0,
  fps = 0;
// ROM Desk: the active tier, and whether Desk holds the machine.
let tier: N64ExecutionTier = 'reference',
  desk = false,
  deskInterrupted = false;
// Play tier: a parallel worker draws streamed graphics tasks. At most two
// tasks may wait for drawing, which keeps machine time tied to real frames.
let rdp: Worker | undefined,
  generation = 0,
  inFlight = 0;
const maxInFlight = 2;
// Yield between bounded chunks without the accumulating delay of nested
// timers. Input and pause remain worker messages; guest clocks are unchanged.
const work = new MessageChannel();
work.port1.onmessage = () => pump();

function send(message: N64WorkerReply): void {
  const transfer: Transferable[] = [];
  if ('pixels' in message && message.pixels) {
    transfer.push(message.pixels.buffer as ArrayBuffer);
  }
  if ('audio' in message) {
    transfer.push(message.audio.buffer as ArrayBuffer);
  }
  port.postMessage(message, transfer);
}
function reset(): void {
  if (!assets) {
    throw new Error('N64 assets have not loaded.');
  }
  running = false;
  previousFrame = 0;
  fps = 0;
  player = new N64Player(
    assets.launch,
    assets.rom,
    assets.ram,
    assets.signal,
    assets.cpu,
    assets.rsp,
    assets.linear,
    assets.idleAddresses,
    assets.local,
  );
  generation++;
  inFlight = 0;
  tier = 'reference';
  if (assets.tier === 'play' && !desk) {
    enterPlayTier();
  }
  send({ type: 'ready', pixels: player.pixels() });
}
/** Start (or return to) the play tier from the machine's current state. The
 * RDP worker receives a fresh copy of RDRAM and the display state. */
function enterPlayTier(): void {
  if (!player || !assets) {
    return;
  }
  generation++;
  inFlight = 0;
  {
    const ram = player.system.memory.ram.bytes.slice();
    const renderer = (rdp ??= startRdp());
    postRdp(
      {
        type: 'init',
        generation,
        ram,
        display: player.system.memory.display.snapshot(),
        height: assets.launch.height,
      },
      [ram.buffer],
    );
    if (assets.blocks) {
      player.enableBlocks(assets.blocks);
    }
    player.enablePlayTier((frame) => {
      inFlight++;
      renderer.postMessage({ type: 'frame', generation, frame } satisfies N64RdpRequest, [
        frame.numbers.buffer,
        frame.bytes.buffer,
      ]);
    });
  }
  tier = 'play';
}
async function load(base: string, tier: N64ExecutionTier): Promise<void> {
  const url = new URL(base),
    own = new URL(import.meta.url);
  if (url.origin !== own.origin) {
    throw new Error('N64 assets must come from this site.');
  }
  const json = async (path: string) => {
    const r = await fetch(new URL(path, url));
    if (!r.ok) {
      throw new Error(`Could not load ${path}.`);
    }
    return r.json();
  };
  const launch = (await json('checkpoint.json')) as N64Launch;
  const binary = async (path: string) => {
    const r = await fetch(new URL(path, url));
    if (!r.ok) {
      throw new Error(`Could not load ${path}.`);
    }
    return new Uint8Array(await r.arrayBuffer());
  };
  const cpuPath = new URL('game-code/program.js', url).href,
    rspPath = new URL('game-code/rsp-play/program.js', url).href;
  const [rom, ram, signal, cpu, rsp] = await Promise.all([
    binary(launch.assets.cartridge),
    binary(launch.assets.rdram),
    binary(launch.assets.signal),
    import(cpuPath) as Promise<Vr4300Program>,
    import(rspPath) as Promise<RspProgram>,
  ]);
  // Play tier: compiled CPU blocks are optional; older packages omit them.
  const blocks =
    tier === 'play'
      ? await (
          import(new URL('game-code/play-blocks.js', url).href) as Promise<{
            blocks: ReadonlyMap<number, Vr4300Block>;
          }>
        )
          .then((module) => module.blocks)
          .catch(() => undefined)
      : undefined;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rom)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== launch.cartridgeSha256) {
    throw new Error('N64 cartridge hash does not match its launch.');
  }
  assets = {
    launch,
    rom,
    ram,
    signal,
    cpu: cpu.step,
    rsp: rsp.step,
    linear: rsp.prepareLinear,
    local: rsp.runLocal,
    idleAddresses: cpu.idleAddresses,
    tier,
    blocks,
  };
  reset();
}
function postRdp(message: N64RdpRequest, transfer: Transferable[]): void {
  rdp?.postMessage(message, transfer);
}
function startRdp(): Worker {
  const worker = new Worker(new URL('./rdp-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<N64RdpReply>) => {
    if (data.generation !== generation || !player) {
      return;
    }
    if (data.type === 'error') {
      running = false;
      send({ type: 'error', detail: data.detail });
      return;
    }
    inFlight--;
    if (data.pixels) {
      frameDrawn();
      update(data.pixels);
    }
    schedule();
  };
  worker.onerror = (event) => {
    running = false;
    send({ type: 'error', detail: event.message });
  };
  return worker;
}
function frameDrawn(): void {
  const now = performance.now();
  if (previousFrame) {
    fps = 1000 / (now - previousFrame);
  }
  previousFrame = now;
}
function update(pixels?: Uint8Array): void {
  if (!player) {
    return;
  }
  send({
    type: 'update',
    ...(pixels ? { pixels } : {}),
    audio: player.takeAudio(),
    polls: player.controls.polls,
    ticks: player.system.ticks,
    fullSyncs: player.system.memory.display.fullSyncs,
    fps,
    rspSpanInstructions:
      player.system.executionStats.rspSpanInstructions +
      player.system.executionStats.rspRunInstructions,
    highLevelTasks: player.system.executionStats.highLevelTasks,
    ...(player.gap ? { gap: player.gap } : {}),
  });
}
// Real-time pacing: the functional machine clock is 93.75 MHz (one CPU
// instruction per tick, as in video.ts and audio.ts). Once the host can run
// faster than the console, the guest must not run ahead of wall time. After a
// stall (hidden tab, pause, slow host) pacing restarts rather than sprinting.
const clockTicksPerMillisecond = 93750,
  maximumLeadMilliseconds = 20,
  maximumLagMilliseconds = 250;
let paceStart = 0,
  paceTicks = 0,
  paceTimer: ReturnType<typeof setTimeout> | undefined;
function restartPacing(): void {
  paceStart = performance.now();
  paceTicks = player?.system.ticks ?? 0;
}
/** Milliseconds to wait before running more guest time; 0 to run now. */
function paceDelay(): number {
  if (!player) {
    return 0;
  }
  const now = performance.now(),
    lead = (player.system.ticks - paceTicks) / clockTicksPerMillisecond - (now - paceStart);
  if (lead < -maximumLagMilliseconds) {
    restartPacing();
    return 0;
  }
  return lead > maximumLeadMilliseconds ? lead - maximumLeadMilliseconds : 0;
}
function schedule(): void {
  if (scheduled || !running) {
    return;
  }
  scheduled = true;
  work.port2.postMessage(null);
}
function pump(): void {
  scheduled = false;
  if (!running || !player) {
    return;
  }
  const streaming = tier === 'play';
  if (streaming && inFlight >= maxInFlight) {
    // The RDP worker's next reply schedules more machine time.
    return;
  }
  const delay = paceDelay();
  if (delay > 0) {
    if (paceTimer === undefined) {
      paceTimer = setTimeout(() => {
        paceTimer = undefined;
        schedule();
      }, delay);
    }
    return;
  }
  try {
    const result = player.advance();
    let pixels: Uint8Array | undefined;
    if (result.frame && !streaming) {
      pixels = player.pixels();
      frameDrawn();
    }
    update(pixels);
    if (player.gap) {
      running = false;
    }
    schedule();
  } catch (error) {
    running = false;
    send({ type: 'error', detail: (error as Error).message });
  }
}
port.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      void load(message.base, message.tier).catch((error) =>
        send({ type: 'error', detail: (error as Error).message }),
      );
    } else if (message.type === 'reset') {
      reset();
    } else if (message.type === 'input') {
      player?.controls.update(message.input);
    } else if (message.type === 'audio') {
      player?.enableAudio(message.sampleRate);
    } else if (message.type === 'pause') {
      running = false;
      player?.controls.clear();
    } else if (message.type === 'desk') {
      void deskRequest(message.request).then(
        (value) => send({ type: 'desk', id: message.id, ...value }),
        (error: unknown) =>
          send({
            type: 'desk',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    } else if (message.type === 'play' && player && !desk) {
      running = true;
      previousFrame = 0;
      restartPacing();
      schedule();
    }
  } catch (error) {
    send({ type: 'error', detail: (error as Error).message });
  }
};

const tierLabel = () =>
  tier === 'play' ? 'play' : 'reference (original CPU and RSP instructions, tick by tick)';
const hex8 = (value: number) => (value >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** Run reference-tier ticks until `done()` is true after a tick, a
 * breakpoint is reached before a tick (never before the first), a gap, or
 * the tick limit. */
function runTicks(
  done: (retired: ReturnType<N64Player['tick']>, before: { cpu: number; rsp: number }) => boolean,
  breakpoints?: ReadonlySet<number>,
  limit = 40000000,
): { result: 'done' | 'breakpoint' | 'gap' | 'limit'; ticks: number } {
  const s = player!.system;
  let ticks = 0,
    result: 'done' | 'breakpoint' | 'gap' | 'limit' = 'limit';
  while (ticks < limit) {
    if (player!.gap) {
      result = 'gap';
      break;
    }
    if (ticks && breakpoints?.has(s.cpu.pc >>> 0)) {
      result = 'breakpoint';
      break;
    }
    const pcs = { cpu: s.cpu.pc >>> 0, rsp: s.memory.signal.pc & 0xffc };
    const retired = player!.tick();
    ticks++;
    if ((ticks & 0xffff) === 0) {
      clearN64Trace(s);
    }
    if (done(retired, pcs)) {
      result = player!.gap ? 'gap' : 'done';
      break;
    }
  }
  clearN64Trace(s);
  return { result, ticks };
}

async function deskRequest(
  request: N64DeskRequest,
): Promise<{ value?: unknown; pixels?: Uint8Array }> {
  if (!player || !assets) {
    throw new Error('The game has not loaded.');
  }
  const p = player,
    s = p.system;
  const state = (last?: string) => n64DeskState(p, tierLabel(), last);
  switch (request.op) {
    case 'interrupt':
      deskInterrupted = true;
      return {};
    case 'open': {
      running = false;
      desk = true;
      p.controls.clear();
      let last = 'Paused at the reference tier.';
      if (tier === 'play' && s.ticks === assets.launch.state.ticks) {
        // Nothing has run since the launch checkpoint, itself a boundary.
        generation++;
        inFlight = 0;
        p.enterReferenceTier();
        tier = 'reference';
        last = 'Paused at the launch checkpoint on the reference tier.';
      } else if (tier === 'play') {
        // Finish this frame on the play tier, then hand over at its FullSync.
        // Drawings still queued for the RDP worker are discarded.
        const sync = s.memory.display.fullSyncs;
        for (let chunk = 0; chunk < 400 && s.memory.display.fullSyncs === sync && !p.gap; chunk++) {
          p.advance(50);
        }
        generation++;
        inFlight = 0;
        p.enterReferenceTier();
        tier = 'reference';
        last =
          'Switched from the play tier to the reference tier at a frame boundary; the next frame redraws the picture.';
      }
      return { value: state(last), pixels: p.pixels() };
    }
    case 'close':
      desk = false;
      deskInterrupted = true;
      if (assets.tier === 'play' && tier !== 'play') {
        enterPlayTier();
      }
      running = !p.gap;
      previousFrame = 0;
      restartPacing();
      schedule();
      return {};
    case 'state':
      return { value: state() };
    case 'read':
      return { value: n64DeskRead(p, request.space, request.address, request.length) };
    case 'restart':
      reset();
      return {
        value: n64DeskState(player, tierLabel(), 'Restarted from the launch checkpoint, paused.'),
        pixels: player.pixels(),
      };
    case 'step': {
      const before = { cpu: s.cpu.pc >>> 0, rsp: s.memory.signal.pc & 0xffc };
      if (request.kind === 'frame') {
        const sync = s.memory.display.fullSyncs;
        const { result, ticks } = runTicks(() => s.memory.display.fullSyncs !== sync);
        return {
          value: state(
            result === 'gap'
              ? 'Stopped at a recovery gap.'
              : `Ran ${ticks.toLocaleString()} ticks to FullSync ${s.memory.display.fullSyncs}.`,
          ),
          pixels: p.pixels(),
        };
      }
      // Step CPU: usually one tick (a pending RSP-only tick may come first).
      // Step RSP: ticks until the RSP retires an instruction, running the
      // CPU until it starts the next task when the RSP is halted.
      const want = request.kind === 'rsp' ? 'rsp' : 'cpu';
      const halted = (s.memory.signal.status & 1) !== 0;
      let final = before,
        flags = { cpu: false, rsp: false, interrupt: false, exception: false };
      const { result, ticks } = runTicks(
        (retired, pcs) => {
          final = pcs;
          flags = retired;
          return retired[want];
        },
        undefined,
        100000000,
      );
      const prefix =
        ticks > 1
          ? `Ran ${ticks.toLocaleString()} ticks${want === 'rsp' && halted ? ' until the CPU started an RSP task' : ''}; on the last, `
          : '';
      return {
        value: state(
          result === 'gap'
            ? 'Stopped at a recovery gap.'
            : result === 'limit'
              ? `Ran ${ticks.toLocaleString()} ticks without the ${want.toUpperCase()} retiring an instruction.`
              : prefix + describeTick(final, flags),
        ),
        pixels: p.pixels(),
      };
    }
    case 'run': {
      const breakpoints = new Set(request.breakpoints.map((address) => address >>> 0));
      deskInterrupted = false;
      let reason: 'breakpoint' | 'frames' | 'gap' = 'frames';
      for (let frame = 0; frame < request.frames; frame++) {
        const sync = s.memory.display.fullSyncs;
        const { result } = runTicks(() => s.memory.display.fullSyncs !== sync, breakpoints);
        send({
          type: 'update',
          pixels: p.pixels(),
          audio: new Float32Array(),
          polls: p.controls.polls,
          ticks: s.ticks,
          fullSyncs: s.memory.display.fullSyncs,
          fps: 0,
          rspSpanInstructions: 0,
          highLevelTasks: s.executionStats.highLevelTasks,
          ...(p.gap ? { gap: p.gap } : {}),
        });
        if (result === 'breakpoint' || result === 'gap') {
          reason = result;
          break;
        }
        // Let Pause and other messages arrive between frames.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (deskInterrupted) {
          break;
        }
      }
      const last =
        reason === 'breakpoint'
          ? `Breakpoint at $${hex8(s.cpu.pc)}.`
          : reason === 'gap'
            ? 'Stopped at a recovery gap.'
            : 'Paused after running.';
      return { value: { ...state(last), stopped: reason }, pixels: p.pixels() };
    }
  }
}
