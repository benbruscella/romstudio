import { N64Player } from '../player.js';
import type { N64Launch } from '../checkpoint.js';
import type { Vr4300Machine, Vr4300Program } from '../../../runtime/vr4300.js';
import type { RspMachine, RspProgram } from '../../../runtime/rsp.js';
import type { N64WorkerRequest, N64WorkerReply } from './protocol.js';

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
    }
  | undefined;
let previousFrame = 0,
  fps = 0;
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
  send({ type: 'ready', pixels: player.pixels() });
}
async function load(base: string): Promise<void> {
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
  };
  reset();
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
  try {
    const result = player.advance();
    let pixels: Uint8Array | undefined;
    if (result.frame) {
      pixels = player.pixels();
      const now = performance.now();
      if (previousFrame) {
        fps = 1000 / (now - previousFrame);
      }
      previousFrame = now;
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
      ...(player.gap ? { gap: player.gap } : {}),
    });
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
      void load(message.base).catch((error) =>
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
      schedule();
    }
  } catch (error) {
    send({ type: 'error', detail: (error as Error).message });
  }
};
