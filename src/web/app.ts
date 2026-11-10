import { browserTitle } from './titles.js';
import { browserKey } from './keyboard.js';
import { BrowserAudio } from './audio.js';
import type { BrowserControls } from '../runtime/controls.js';
import type { BrowserTitle, ShellPlayer, TitleAction } from './shell-types.js';
import type { Machine } from '../runtime/mos6502.js';
import { deskView } from './desk/view.js';
import { mos6502Desk } from './desk/mos6502.js';

const get = <T extends HTMLElement>(id: string): T => {
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
  pause = get<HTMLButtonElement>('pause'),
  example = get<HTMLButtonElement>('example');
const status = get('status'),
  outcome = get('outcome'),
  held = new Set<string>();
const statViews = new Map<string, HTMLElement>(),
  pulses = new Map<number, Set<string>>();
const fireFrames = new Set<number>();
const audio = new BrowserAudio();
let soundWanted = true;
let title: BrowserTitle,
  checkpoint: unknown,
  translatedStep: (machine: Machine) => void,
  reference: unknown;
let player: ShellPlayer | undefined,
  started = false,
  running = false,
  demo = false,
  exampleEnd = 0,
  lastTime = 0,
  accumulated = 0,
  speed = 1;
function setSpeed(value: number): void {
  audio.stop();
  speed = value;
  updateSoundNote();
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-speed]'))) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === value));
  }
}
function updateSoundNote(): void {
  get('sound-note').textContent = !title?.audioSupported
    ? (title?.audioDescription ?? '')
    : !soundWanted
      ? 'Muted'
      : speed !== 1
        ? 'Sound plays at 1× speed.'
        : audio.active
          ? title.audioDescription
          : 'Press a game key or Enable sound for audio.';
  get('sound').textContent =
    soundWanted && !audio.active ? 'Enable sound' : soundWanted ? 'Sound on' : 'Sound off';
  get('sound').setAttribute('aria-pressed', String(soundWanted && audio.active));
}
function startSound(): void {
  if (!soundWanted || !player || !title.audioSupported) {
    return;
  }
  void audio
    .resume()
    .then(() => {
      player?.enableAudio(audio.sampleRate);
      updateSoundNote();
    })
    .catch(() => {
      get('sound-note').textContent = 'Sound unavailable. Press Sound on to retry.';
    });
}
function pulse(action: TitleAction): void {
  if (!player) {
    return;
  }
  for (const offset of action.offsets) {
    const frame = player.controlFrames + offset;
    const keys = pulses.get(frame) ?? new Set<string>();
    keys.add(action.code);
    pulses.set(frame, keys);
  }
  canvas.focus();
}
const heldInput = (frame: number): BrowserControls => {
  const pressed = new Set([...held, ...(pulses.get(frame) ?? [])]);
  if (fireFrames.has(frame)) {
    pressed.add('Space');
  }
  const pad = navigator.getGamepads?.().find((pad) => pad?.connected);
  if (pad) {
    if ((pad.axes[1] ?? 0) < -0.35 || pad.buttons[12]?.pressed) {
      pressed.add('ArrowUp');
    }
    if ((pad.axes[1] ?? 0) > 0.35 || pad.buttons[13]?.pressed) {
      pressed.add('ArrowDown');
    }
    if ((pad.axes[0] ?? 0) < -0.35 || pad.buttons[14]?.pressed) {
      pressed.add('ArrowLeft');
    }
    if ((pad.axes[0] ?? 0) > 0.35 || pad.buttons[15]?.pressed) {
      pressed.add('ArrowRight');
    }
    if (pad.buttons[0]?.pressed) {
      pressed.add('Space');
    }
    if (pad.buttons[9]?.pressed) {
      pressed.add('Enter');
    }
    if (pad.buttons[8]?.pressed) {
      pressed.add('ShiftRight');
    }
    const shortcut = title.actions.find((action) => action.id === title.gamepadShortcut);
    if (pad.buttons[1]?.pressed && shortcut) {
      pressed.add(shortcut.code);
    }
  }
  for (const scheduled of pulses.keys()) {
    if (scheduled < frame) {
      pulses.delete(scheduled);
    }
  }
  for (const scheduled of fireFrames) {
    if (scheduled < frame) {
      fireFrames.delete(scheduled);
    }
  }
  return { pressed: [...pressed].sort() };
};
function reset(exampleMode: boolean, automatic = false): void {
  audio.stop();
  held.clear();
  pulses.clear();
  fireFrames.clear();
  lastPulse.clear();
  demo = exampleMode;
  player = title.create(checkpoint, translatedStep, heldInput, demo ? reference : undefined);
  started = true;
  running = true;
  lastTime = 0;
  accumulated = 0;
  outcome.hidden = true;
  if (!automatic) {
    canvas.focus();
  }
  play.textContent = 'Restart';
  pause.textContent = 'Pause';
  pause.disabled = false;
  status.textContent = demo ? 'Playing example' : 'Playing';
  status.dataset.state = 'playing';
  if (demo) {
    setSpeed(4);
  }
  if (!automatic || audio.active) {
    startSound();
  }
  updateSoundNote();
  updateStats();
}
function updateStats(): void {
  if (!player) {
    return;
  }
  canvas.dataset.inputPolls = String(player.controlFrames);
  const stats = player.stats();
  for (const [key, element] of statViews) {
    element.textContent = String(stats[key] ?? '—');
  }
  for (const action of title.actions) {
    if (action.toggle) {
      get(action.id).setAttribute('aria-pressed', String(player.selected(action.id)));
    }
  }
  const result = player.result;
  if (result) {
    audio.stop();
    running = false;
    pause.disabled = true;
    status.textContent = result.won ? 'Level complete' : 'Level ended';
    status.dataset.state = result.won ? 'won' : 'lost';
    get('result-title').textContent = result.title;
    get('result-detail').textContent = result.detail;
    outcome.hidden = false;
  } else if (player.gap) {
    audio.stop();
    running = false;
    pause.disabled = true;
    status.textContent = 'Unsupported path';
    status.dataset.state = 'gap';
    get('result-title').textContent = 'This path needs more recovery';
    get('result-detail').textContent =
      'This build has incomplete coverage. Restart or play the checked example.';
    outcome.hidden = false;
    console.error('ROM Studio recovery gap', player.gap);
  } else if (demo && player.controlFrames >= exampleEnd) {
    audio.stop();
    running = false;
    pause.disabled = true;
    status.textContent = 'Example complete';
  } else if (running && !demo) {
    status.textContent = player.startPrompt ?? 'Playing';
  }
}
function drawScreen(): void {
  if (!player) {
    return;
  }
  context!.putImageData(
    new ImageData(
      Uint8ClampedArray.from(player.display.pixels),
      title.display.width,
      title.display.height,
    ),
    0,
    0,
  );
}
// ROM Desk pauses the frame loop and drives the same player directly.
let deskActive = false;
const desk = deskView({
  button: get<HTMLButtonElement>('desk-toggle'),
  section: get('desk'),
  symbolsUrl: './desk/symbols.json',
  target: () =>
    mos6502Desk({
      system: (document.body.dataset.system as 'c64' | 'nes') ?? 'c64',
      host: () => player?.desk,
      pause: () => {
        deskActive = true;
        running = false;
        held.clear();
        audio.stop();
        pause.textContent = 'Resume';
        pause.disabled = true;
        status.textContent = 'ROM Desk';
        status.dataset.state = 'desk';
      },
      resume: () => {
        deskActive = false;
        running = !player?.gap && !player?.result;
        lastTime = 0;
        accumulated = 0;
        pause.textContent = 'Pause';
        pause.disabled = false;
        status.textContent = demo ? 'Playing example' : 'Playing';
        status.dataset.state = 'playing';
        if (running) {
          startSound();
        }
      },
      restart: () => reset(demo, true),
      picture: () => {
        drawScreen();
        updateStats();
      },
    }),
});
function animate(time: number): void {
  if (player && running && !document.hidden) {
    if (lastTime) {
      accumulated += (Math.min(100, time - lastTime) * speed) / 1000;
    }
    lastTime = time;
    let frames = 0;
    while (accumulated >= title.display.frameSeconds && frames++ < 8 && running) {
      player.advanceFrame();
      accumulated -= title.display.frameSeconds;
      const samples = player.takeAudio();
      if (soundWanted && speed === 1 && running) {
        audio.queue(samples);
      }
      if (player.result || player.gap || (demo && player.controlFrames >= exampleEnd)) {
        updateStats();
      }
    }
    accumulated = Math.min(accumulated, 0.2);
    drawScreen();
    updateStats();
  } else {
    lastTime = 0;
  }
  requestAnimationFrame(animate);
}
function configureTitle(): void {
  canvas.width = title.display.width;
  canvas.height = title.display.height;
  get('hardware-note').textContent = title.audioDescription;
  get<HTMLButtonElement>('sound').disabled = !title.audioSupported;
  document.title = `${title.title} · ROM Studio`;
  get('game-title').textContent = title.title;
  get('eyebrow').textContent = title.eyebrow;
  get('edition').textContent = title.edition;
  get('goal').textContent = title.goal;
  get('heading').textContent = title.heading;
  get('description').textContent = title.description;
  get('game').setAttribute('aria-label', `${title.title} game`);
  canvas.setAttribute('aria-label', `${title.title} game screen`);
  get('example-about').textContent = title.example;
  for (const stat of title.stats) {
    const card = document.createElement('div'),
      label = document.createElement('span'),
      value = document.createElement('strong');
    label.textContent = stat.label;
    value.id = stat.id;
    card.append(label, value);
    get('scoreboard').append(card);
    statViews.set(stat.id, value);
  }
  for (const action of title.actions) {
    const button = document.createElement('button');
    button.id = action.id;
    button.dataset.keycode = action.code;
    if (action.quiet) {
      button.className = 'quiet';
    }
    if (action.toggle) {
      button.setAttribute('aria-pressed', 'false');
    }
    if (action.hint) {
      const hint = document.createElement('span');
      hint.textContent = action.hint;
      button.append(hint);
    }
    button.append(document.createTextNode(action.label));
    if (action.counter) {
      const count = document.createElement('strong');
      count.id = action.counter.id;
      button.append(count);
      statViews.set(action.counter.stat, count);
    }
    button.addEventListener('click', () => pulse(action));
    get('title-actions').append(button);
  }
  for (const line of title.help) {
    const p = document.createElement('p');
    p.textContent = line;
    get('help-lines').append(p);
  }
  for (const link of title.learn) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    get('learn-links').append(a);
  }
}
play.addEventListener('click', () => reset(false));
example.addEventListener('click', () => reset(true));
pause.addEventListener('click', () => {
  if (deskActive) {
    return;
  }
  audio.stop();
  running = !running;
  held.clear();
  pause.textContent = running ? 'Pause' : 'Resume';
  status.textContent = running ? (demo ? 'Playing example' : 'Playing') : 'Paused';
  lastTime = 0;
  if (running) {
    startSound();
  }
});
get('sound').addEventListener('click', () => {
  soundWanted = !audio.active || !soundWanted;
  audio.stop();
  get('sound').setAttribute('aria-pressed', String(soundWanted));
  get('sound').textContent = soundWanted ? 'Sound on' : 'Sound off';
  updateSoundNote();
  if (soundWanted && running) {
    startSound();
  }
});
get('fullscreen').addEventListener('click', async () => {
  try {
    await get('game').requestFullscreen();
  } catch {
    status.textContent = 'Fullscreen unavailable';
  }
});
const commonKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Enter',
  'KeyZ',
  'KeyX',
  'ShiftRight',
]);
const lastPulse = new Map<string, number>();
function keyboard(code: string, down: boolean, repeat = false): boolean {
  if (
    !(commonKeys.has(code) || title?.actions.some((action) => action.code === code)) ||
    !player ||
    !running
  ) {
    return false;
  }
  if (!down) {
    held.delete(code);
    return true;
  }
  if (!audio.active) {
    startSound();
  }
  if (repeat) {
    return true;
  }
  // Original key scanning is less frequent than cursor polling. Retain a short
  // tap until at least one scan can see it, including quick browser keyups.
  const duration = code === 'Digit8' || code === 'Delete' ? 6 : (title.minimumInputPolls ?? 2);
  const first = Math.max(
    player.controlFrames + 1,
    code === 'Delete' ? (lastPulse.get(code) ?? -6) + 7 : 0,
  );
  for (let frame = first; frame < first + duration; frame++) {
    const keys = pulses.get(frame) ?? new Set<string>();
    keys.add(code);
    pulses.set(frame, keys);
  }
  lastPulse.set(code, first + duration - 1);
  // Delete is edge-triggered by the game. Queue distinct short presses with
  // a release interval so two rapid Mac Delete taps remain two matrix edges.
  if (code !== 'Delete') {
    held.add(code);
  }
  return true;
}
document.addEventListener('keydown', (event) => {
  if (
    event.target instanceof HTMLElement &&
    ['SELECT', 'INPUT', 'TEXTAREA'].includes(event.target.tagName)
  ) {
    return;
  }
  if (keyboard(browserKey(event), true, event.repeat)) {
    event.preventDefault();
  }
});
document.addEventListener('keyup', (event) => {
  if (keyboard(browserKey(event), false)) {
    event.preventDefault();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (
    running &&
    !audio.active &&
    !(event.target instanceof Element && event.target.closest('#sound'))
  ) {
    startSound();
  }
});
window.addEventListener('message', (event) => {
  const data = event.data as {
    type?: string;
    code?: string;
    key?: string;
    down?: boolean;
    repeat?: boolean;
  };
  if (
    event.source !== window.parent ||
    event.origin !== location.origin ||
    data?.type !== 'rom-studio-key' ||
    typeof data.code !== 'string' ||
    typeof data.key !== 'string' ||
    typeof data.down !== 'boolean'
  ) {
    return;
  }
  keyboard(browserKey({ code: data.code, key: data.key }), data.down, !!data.repeat);
});
window.addEventListener('blur', () => held.clear());
window.addEventListener('pagehide', () => audio.stop());
document.addEventListener('visibilitychange', () => {
  held.clear();
  lastTime = 0;
  accumulated = 0;
  audio.stop();
});
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-speed]'))) {
  button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)));
}
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-key]'))) {
  const key = button.dataset.key!;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    held.add(key);
    if (key === 'Space' && player) {
      fireFrames.add(player.controlFrames + 1);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => held.delete(key));
  }
}
canvas.addEventListener('pointerdown', () => {
  if (player && !running && !started) {
    reset(false);
    return;
  }
  if (player) {
    fireFrames.add(player.controlFrames + 1);
  }
  canvas.focus();
});
async function start(): Promise<void> {
  try {
    const modulePath = '../game-code/program.js';
    const [manifest, data, log, code] = await Promise.all([
      fetch('./manifest.json').then((response) => response.json()) as Promise<{
        titleId: string;
        system: string;
        shell: { titleModule: string };
        example: { controlFrames: number; completion?: boolean };
      }>,
      fetch('./checkpoint.json').then((response) => response.json()),
      fetch('./example.json').then((response) => response.json()),
      import(modulePath) as Promise<{ step: (machine: Machine) => void }>,
    ]);
    title = await browserTitle(manifest.shell.titleModule);
    if (title.id !== manifest.titleId) {
      throw new Error('Title adapter does not match the package.');
    }
    get('system-name').textContent =
      manifest.system === 'c64'
        ? 'COMMODORE 64'
        : manifest.system === 'nes'
          ? 'NINTENDO ENTERTAINMENT SYSTEM'
          : manifest.system.toUpperCase();
    document.body.dataset.system = manifest.system;
    configureTitle();
    checkpoint = data;
    reference = log;
    // A completion route can reach its native result after the last input poll.
    // Only controls-only examples stop at the recorded input boundary.
    translatedStep = code.step;
    exampleEnd = manifest.example.completion === false ? manifest.example.controlFrames : Infinity;
    play.disabled = false;
    example.disabled = false;
    // Run the original startup/title immediately. User input still goes through
    // the game; only browser audio waits for an interaction.
    reset(false, true);
    desk.ready();
  } catch (error) {
    status.textContent = 'Unable to load';
    console.error(error);
  }
}
requestAnimationFrame(animate);
void start();
