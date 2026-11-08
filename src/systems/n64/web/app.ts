import { BrowserAudio } from '../../../web/audio.js';
import { browserKey } from '../../../web/keyboard.js';
import type { N64WorkerRequest, N64WorkerReply, N64WebTitle } from './protocol.js';

const get = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing ${id}.`);
  }
  return element as T;
};
const canvas = get<HTMLCanvasElement>('screen'),
  context = canvas.getContext('2d');
if (!context) {
  throw new Error('Canvas is unavailable.');
}
const play = get<HTMLButtonElement>('play'),
  pause = get<HTMLButtonElement>('pause');
const status = get('status'),
  audio = new BrowserAudio(),
  held = new Set<string>();
let worker: Worker | undefined,
  title: N64WebTitle,
  ready = false,
  started = false,
  running = false,
  sound = true,
  restart = false;

function post(message: N64WorkerRequest): void {
  worker?.postMessage(message);
}
function startSound(): void {
  if (!sound || !running) {
    return;
  }
  void audio
    .resume()
    .then(() => {
      post({ type: 'audio', sampleRate: audio.sampleRate });
      get('sound').textContent = 'Sound on';
      get('sound').setAttribute('aria-pressed', 'true');
      get('sound-note').textContent = 'Original stereo PCM; output is approximate.';
    })
    .catch(() => {
      get('sound-note').textContent = 'Press Enable sound to retry audio.';
    });
}
function draw(pixels: Uint8Array): void {
  context!.putImageData(
    new ImageData(Uint8ClampedArray.from(pixels), canvas.width, canvas.height),
    0,
    0,
  );
}
function failure(detail: string): void {
  running = false;
  audio.stop();
  pause.disabled = true;
  status.textContent = 'Stopped';
  status.dataset.state = 'gap';
  get('result-title').textContent = 'This path needs more recovery';
  get('result-detail').textContent = detail;
  get('outcome').hidden = false;
  console.error('ROM Studio N64 recovery stop:', detail);
}
function begin(automatic = false): void {
  if (!ready) {
    return;
  }
  started = running = true;
  held.clear();
  get('outcome').hidden = true;
  play.textContent = 'Restart';
  pause.textContent = 'Pause';
  pause.disabled = false;
  status.textContent = 'Playing';
  status.dataset.state = 'playing';
  if (!automatic || audio.active) {
    startSound();
  }
  post({ type: 'play' });
  if (!automatic) {
    canvas.focus();
  }
}
function key(code: string, down: boolean, repeat = false): boolean {
  if (
    !running ||
    !new Set([
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      ...title.actions.map((a) => a.code),
      'KeyZ',
    ]).has(code)
  ) {
    return false;
  }
  if (!repeat) {
    if (down && !audio.active) {
      startSound();
    }
    if (down) {
      held.add(code);
    } else {
      held.delete(code);
    }
    input();
  }
  return true;
}
function input(): void {
  const keys = new Set(held),
    pad = navigator.getGamepads?.().find((p) => p?.connected);
  let stickX = 0,
    stickY = 0;
  if (pad) {
    stickX = Math.abs(pad.axes[0] ?? 0) > 0.15 ? (pad.axes[0] ?? 0) * 80 : 0;
    stickY = Math.abs(pad.axes[1] ?? 0) > 0.15 ? -(pad.axes[1] ?? 0) * 80 : 0;
    for (const [button, code] of [
      [0, 'Space'],
      [1, 'KeyX'],
      [6, 'ShiftLeft'],
      [5, 'ShiftRight'],
      [9, 'Enter'],
      [12, 'ArrowUp'],
      [13, 'ArrowDown'],
      [14, 'ArrowLeft'],
      [15, 'ArrowRight'],
    ] as const) {
      if (pad.buttons[button]?.pressed) {
        keys.add(code);
      }
    }
  }
  post({ type: 'input', input: { pressed: [...keys], stickX, stickY } });
}
play.addEventListener('click', () => {
  audio.stop();
  if (!started) {
    begin();
  } else {
    ready = false;
    running = false;
    restart = true;
    status.textContent = 'Restarting…';
    post({ type: 'reset' });
  }
});
function suspend(): void {
  running = false;
  held.clear();
  audio.stop();
  post({ type: 'pause' });
  pause.textContent = 'Resume';
  status.textContent = 'Paused';
}
pause.addEventListener('click', () => {
  if (running) {
    suspend();
  } else {
    begin();
  }
});
get('sound').addEventListener('click', () => {
  sound = !audio.active || !sound;
  audio.stop();
  get('sound').textContent = sound ? 'Sound on' : 'Sound off';
  get('sound').setAttribute('aria-pressed', String(sound));
  if (sound && running) {
    startSound();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!audio.active && !(event.target instanceof Element && event.target.closest('#sound'))) {
    startSound();
  }
});
get('fullscreen').addEventListener('click', () => void get('game').requestFullscreen());
for (const type of ['keydown', 'keyup'] as const) {
  document.addEventListener(type, (event) => {
    if (event.target instanceof Element && event.target.closest('input,textarea,select')) {
      return;
    }
    if (key(browserKey(event), type === 'keydown', event.repeat)) {
      event.preventDefault();
    }
  });
}
window.addEventListener('message', (event) => {
  const data = event.data as {
    type?: string;
    code?: string;
    key?: string;
    down?: boolean;
    repeat?: boolean;
  };
  if (
    event.source === window.parent &&
    event.origin === location.origin &&
    data?.type === 'rom-studio-key' &&
    typeof data.code === 'string' &&
    typeof data.key === 'string' &&
    typeof data.down === 'boolean'
  ) {
    key(browserKey({ code: data.code, key: data.key }), data.down, data.repeat);
  }
});
window.addEventListener('blur', () => {
  held.clear();
  if (running) {
    input();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) {
    suspend();
  }
});
window.addEventListener('pagehide', () => {
  audio.stop();
  worker?.terminate();
});
function animate(): void {
  if (running) {
    input();
  }
  requestAnimationFrame(animate);
}

async function start(): Promise<void> {
  const base = new URL('../../../', import.meta.url);
  const response = await fetch(new URL('manifest.json', base));
  if (!response.ok) {
    throw new Error('Could not load the game manifest.');
  }
  const manifest = (await response.json()) as { titleId: string; shell: { titleModule: string } };
  if (!/^\.\.\/games\/n64\/[a-z0-9-]+\/web\/title\.js$/.test(manifest.shell.titleModule)) {
    throw new Error('Invalid N64 title module.');
  }
  const path = new URL(manifest.shell.titleModule, new URL('web/', base)).href;
  title = ((await import(path)) as { title: N64WebTitle }).title;
  if (title.id !== manifest.titleId) {
    throw new Error('N64 title does not match the package.');
  }
  canvas.width = 320;
  canvas.height = 240;
  canvas.setAttribute('aria-label', title.title + ' game screen');
  get('game').setAttribute('aria-label', title.title + ' game');
  const touchA = document.querySelector<HTMLElement>('[data-key="Space"]');
  if (touchA) {
    touchA.textContent = 'A';
    touchA.setAttribute('aria-label', 'A button');
  }
  document.title = title.title + ' · ROM Studio';
  for (const [id, text] of [
    ['game-title', title.title],
    ['eyebrow', title.eyebrow],
    ['system-name', 'NINTENDO 64'],
    ['edition', 'ORIGINAL ROM STUDY'],
    ['goal', 'EXPLORE THE ORIGINAL'],
    ['heading', title.title],
    ['description', title.description],
    ['sound-note', 'Press a game key or Enable sound for audio.'],
    ['hardware-note', 'N64 rendering and timing remain approximate.'],
  ]) {
    get(id!).textContent = text!;
  }
  get('scoreboard').hidden = true;
  get('example').hidden = true;
  get('speed').parentElement!.hidden = true;
  get('example-about').textContent =
    'Original title-to-opening execution passes static replay. Broader play remains under validation.';
  for (const action of title.actions) {
    const button = document.createElement('button');
    button.dataset.keycode = action.code;
    button.textContent = action.label;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      key(action.code, true);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(event, () => key(action.code, false));
    }
    get('title-actions').append(button);
  }
  for (const help of title.help) {
    const p = document.createElement('p');
    p.textContent = help;
    get('help-lines').append(p);
  }
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-key]'))) {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      key(button.dataset.key!, true);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(event, () => key(button.dataset.key!, false));
    }
  }
  const link = document.createElement('a');
  link.href = new URL('learn/README.md', base).href;
  link.textContent = 'About this recovery';
  get('learn-links').append(link);
  status.textContent = 'Loading translated N64 code…';
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (event) => failure(event.message);
  worker.onmessage = (event: MessageEvent<N64WorkerReply>) => {
    const message = event.data;
    if (message.type === 'error') {
      failure(message.detail);
      return;
    }
    if (message.type === 'ready') {
      ready = true;
      draw(message.pixels);
      play.disabled = false;
      const automatic = !restart;
      restart = false;
      begin(automatic);
    } else {
      if (message.pixels) {
        draw(message.pixels);
      }
      if (sound && running) {
        audio.queue(message.audio, 2);
      }
      if (message.gap) {
        failure(
          `${message.gap.detail} (${message.gap.kind}, CPU $${message.gap.pc.toString(16).toUpperCase()})`,
        );
      } else if (running) {
        status.textContent = message.fps ? `Playing · ${message.fps.toFixed(1)} fps` : 'Playing…';
      }
      canvas.dataset.inputPolls = String(message.polls);
      canvas.dataset.fullSyncs = String(message.fullSyncs);
      canvas.dataset.ticks = String(message.ticks);
      canvas.dataset.rspSpanInstructions = String(message.rspSpanInstructions);
    }
  };
  post({ type: 'load', base: base.href });
}
requestAnimationFrame(animate);
void start().catch((error) => failure((error as Error).message));
