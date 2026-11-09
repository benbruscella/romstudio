import { N64Player } from '../player.js';
import type { Vr4300Block } from '../system.js';
import type { N64Launch } from '../checkpoint.js';
import type { Vr4300Machine, Vr4300Program } from '../../../runtime/vr4300.js';
import type { RspMachine, RspProgram } from '../../../runtime/rsp.js';
import type {
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
  if (assets.tier === 'play') {
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
  send({ type: 'ready', pixels: player.pixels() });
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
  const streaming = assets?.tier === 'play';
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
    } else if (message.type === 'play' && player) {
      running = true;
      previousFrame = 0;
      restartPacing();
      schedule();
    }
  } catch (error) {
    send({ type: 'error', detail: (error as Error).message });
  }
};
