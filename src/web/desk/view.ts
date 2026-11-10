import { createDesk } from './panel.js';
import type { DeskTarget } from './types.js';

/** Opens and closes ROM Desk on a game page. Inside the library, the page
 * follows the library's route: switching Play ↔ Desk posts a message rather
 * than reloading, so the running game carries over. A direct `?desk=1` load
 * opens Desk once the game is ready. */
export function deskView(options: {
  button: HTMLButtonElement;
  section: HTMLElement;
  target: () => DeskTarget;
  symbolsUrl: string;
}): { ready(): void; readonly wanted: boolean } {
  let panel: Awaited<ReturnType<typeof createDesk>> | undefined,
    opening: Promise<void> | undefined,
    loaded = false,
    wanted = new URLSearchParams(location.search).get('desk') === '1';
  const embedded = window.parent !== window;
  const update = () => {
    const open = !!panel || !!opening;
    options.button.textContent = open ? 'Close ROM Desk' : 'Open ROM Desk';
    options.button.setAttribute('aria-pressed', String(open));
    document.body.classList.toggle('desk-open', open);
  };
  const open = async () => {
    if (panel || opening) {
      return;
    }
    options.section.hidden = false;
    opening = createDesk(options.section, options.target(), {
      symbolsUrl: options.symbolsUrl,
    }).then((value) => {
      panel = value;
      opening = undefined;
      update();
    });
    update();
    await opening;
  };
  const close = async () => {
    await opening;
    const current = panel;
    panel = undefined;
    options.section.hidden = true;
    options.section.replaceChildren();
    update();
    await current?.close();
  };
  const apply = () => {
    if (!loaded) {
      return;
    }
    void (wanted ? open() : close()).catch((error) => console.error(error));
  };
  options.button.addEventListener('click', () => {
    const next = !(panel || opening);
    if (embedded) {
      // The library owns the URL: it updates history and replies with a view message.
      window.parent.postMessage(
        { type: 'rom-studio-navigate', view: next ? 'desk' : 'play' },
        location.origin,
      );
      return;
    }
    wanted = next;
    const url = new URL(location.href);
    if (next) {
      url.searchParams.set('desk', '1');
    } else {
      url.searchParams.delete('desk');
    }
    history.replaceState(null, '', url);
    apply();
  });
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; view?: string };
    if (
      event.source !== window.parent ||
      event.origin !== location.origin ||
      data?.type !== 'rom-studio-view' ||
      (data.view !== 'desk' && data.view !== 'play')
    ) {
      return;
    }
    wanted = data.view === 'desk';
    apply();
  });
  return {
    /** Whether Desk should be open (for example from a direct `?desk=1` link). */
    get wanted() {
      return wanted;
    },
    ready() {
      loaded = true;
      options.button.disabled = false;
      apply();
    },
  };
}
