import type { CatalogGame } from '../../build/site.js';
import type { LearningMaterial } from '../../build/learn.js';
import { codeExplorer } from './code.js';
import { historyRouter, libraryRoute } from './router.js';

interface System {
  id: string;
  name: string;
  description: string;
}
const items = document.querySelector<HTMLElement>('#items')!,
  heading = document.querySelector<HTMLElement>('#heading')!;
const description = document.querySelector<HTMLElement>('#description')!,
  eyebrow = document.querySelector<HTMLElement>('#eyebrow')!,
  crumbs = document.querySelector<HTMLElement>('#breadcrumbs')!;
const base = document.querySelector<HTMLMetaElement>('meta[name="rom-studio-base"]')!.content;
const url = (path = '') => base + path;
const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text) {
    node.textContent = text;
  }
  return node;
};
const link = (text: string, path: string, className = '') => {
  const node = element('a', text);
  node.href = url(path);
  node.className = className;
  return node;
};
const playLabel = (game: CatalogGame): string => (game.experimental ? 'Try study' : 'Play Game');
function showCurrentChapter(): void {
  const navigation = items.querySelector<HTMLElement>('.chapters');
  const current = navigation?.querySelector<HTMLElement>('[aria-current="page"]');
  if (navigation && current && navigation.scrollWidth > navigation.clientWidth) {
    current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
let chapterWidth = items.clientWidth;
const chapterResize = new ResizeObserver(() => {
  if (items.clientWidth !== chapterWidth) {
    chapterWidth = items.clientWidth;
    showCurrentChapter();
  }
});
chapterResize.observe(items);
let revision = 0;
try {
  const redirect = new URLSearchParams(location.search).get('route');
  if (redirect) {
    const destination = new URL(redirect, location.origin);
    if (destination.origin === location.origin && libraryRoute(destination.pathname, base)) {
      history.replaceState(null, '', destination);
    }
  }
  const response = await fetch(url('catalog.json'));
  if (!response.ok) {
    throw new Error('The game catalog is unavailable.');
  }
  const catalog = (await response.json()) as { systems: System[]; games: CatalogGame[] };

  async function learn(
    game: CatalogGame,
    chapter: string | undefined,
    version: number,
  ): Promise<void> {
    const response = await fetch(url(game.learning));
    if (!response.ok) {
      throw new Error('Learning material is unavailable.');
    }
    const material = (await response.json()) as LearningMaterial;
    if (version !== revision) {
      return;
    }
    const view = element('div');
    view.className = 'learn-view';
    const navigation = element('nav');
    navigation.className = 'chapters';
    navigation.setAttribute('aria-label', 'Game chapters');
    const current =
      material.chapters.find((item) => item.slug === chapter) ?? material.chapters[0]!;
    const sources = game.codeDirectory
      ? [
          {
            id: 'cpu',
            label: game.codeSources?.length ? 'CPU assembly → TypeScript' : 'Assembly → TypeScript',
            directory: game.codeDirectory,
            chapter: 'code',
          },
          ...(game.codeSources ?? []).map((source) => ({
            ...source,
            chapter: 'code-' + source.id,
          })),
        ]
      : [];
    const selectedSource = sources.find((source) => source.chapter === chapter);
    for (const item of material.chapters) {
      const anchor = link(item.title, `${game.system}/${game.id}/learn/${item.slug}`);
      if (item === current && !selectedSource) {
        anchor.setAttribute('aria-current', 'page');
      }
      navigation.append(anchor);
    }
    for (const source of sources) {
      const explorerLink = link(source.label, `${game.system}/${game.id}/learn/${source.chapter}`);
      if (source === selectedSource) {
        explorerLink.setAttribute('aria-current', 'page');
      }
      navigation.append(explorerLink);
    }
    if (selectedSource) {
      const explorer = await codeExplorer(url(selectedSource.directory));
      if (version !== revision) {
        return;
      }
      view.append(navigation, explorer);
      items.append(view);
      requestAnimationFrame(showCurrentChapter);
      return;
    }
    const article = element('article');
    article.className = 'prose';
    article.innerHTML = current.html;
    if (material.code.length) {
      article.append(element('h2', 'Read the source'));
      for (const source of material.code) {
        const detail = element('details'),
          summary = element('summary', source.name),
          pre = element('pre'),
          code = element('code', source.text);
        pre.append(code);
        detail.append(summary, element('p', source.purpose), pre);
        article.append(detail);
      }
    }
    if (game.codeDirectory) {
      article.append(
        link(
          'Read the generated original-instruction TypeScript ↗',
          game.codeDirectory + 'program.ts',
        ),
      );
    }
    view.append(navigation, article);
    items.append(view);
    requestAnimationFrame(showCurrentChapter);
  }

  function render(): void {
    const version = ++revision,
      route = libraryRoute(location.pathname, base);
    const system = catalog.systems.find((item) => item.id === route?.system);
    const game = catalog.games.find(
      (item) => item.system === system?.id && item.id === route?.game,
    );
    const playing = !!game && route?.view === 'play' && game.runnable;
    document.body.classList.toggle('playing', playing);
    document.body.classList.toggle('learning', !!game && !playing);
    items.replaceChildren();
    crumbs.replaceChildren();
    if (!route || (route.system && !system) || (route.game && !game)) {
      heading.textContent = 'Page not found.';
      eyebrow.textContent = 'ROM STUDIO';
      description.textContent = 'Choose a system to return to the library.';
      items.append(link('All systems', ''));
      return;
    }
    if (system) {
      crumbs.append(link('All systems', ''));
      if (game) {
        crumbs.append(link(system.name, system.id));
      }
    }
    if (game) {
      const tabs = element('span');
      tabs.className = 'view-tabs';
      if (game.runnable) {
        tabs.append(link(playLabel(game), `${system!.id}/${game.id}`, playing ? 'active' : ''));
      }
      tabs.append(link('Learn', `${system!.id}/${game.id}/learn`, playing ? '' : 'active'));
      crumbs.append(element('span', game.name), tabs);
      if (game.experimental) {
        const badge = element('span', 'Experimental study');
        badge.className = 'study-label';
        badge.title = 'Only documented routes are verified. This is not a release-ready game.';
        crumbs.insertBefore(badge, tabs);
      }
    }
    heading.textContent = game?.name ?? system?.name ?? 'Choose your system.';
    eyebrow.textContent = game ? 'LEARN THE GAME' : system ? 'CHOOSE A GAME' : 'THE LIBRARY';
    description.textContent = game
      ? 'Original instructions, recovered explanations, and the evidence connecting them.'
      : system
        ? 'Explore the game code, or try an experimental recovery. Only release-ready games receive Play Game.'
        : 'Pick a machine. Explore a game.';
    document.title = `${game?.name ?? system?.name ?? 'Game library'} · ROM Studio`;
    if (game) {
      if (!playing) {
        void learn(game, route.chapter, version).catch((error) => {
          if (version === revision) {
            description.textContent = String(error);
          }
        });
        return;
      }
      const view = element('div');
      view.className = 'game-view';
      const frame = element('iframe');
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        if (!doc?.body) {
          return;
        }
        doc.body.classList.add('embedded');
        const status = doc.querySelector('#status'),
          aside = doc.querySelector('aside');
        if (status && aside) {
          aside.prepend(status);
        }
        const css = doc.createElement('link');
        css.rel = 'stylesheet';
        css.href = new URL(url('player-embed.css'), location.origin).href;
        doc.head.append(css);
      });
      frame.src = url(game.entry!) + '?embed=1';
      frame.title = game.name;
      frame.allow = 'autoplay; fullscreen; gamepad';
      frame.allowFullscreen = true;
      view.append(frame);
      items.append(view);
      return;
    }
    if (!system) {
      for (const system of catalog.systems) {
        const games = catalog.games.filter((game) => game.system === system.id),
          card = link('', system.id, `card ${system.id}`);
        const art = element('div');
        art.className = 'art';
        const symbol = element('span', system.id.toUpperCase());
        symbol.className = 'symbol';
        art.append(symbol);
        const body = element('div');
        body.className = 'card-body';
        const meta = element(
          'span',
          `${games.filter((game) => game.runnable && !game.experimental).length} READY · ${games.filter((game) => game.experimental).length} STUDIES`,
        );
        meta.className = 'meta';
        const go = element('span', 'Choose games ↗');
        go.className = 'go';
        body.append(meta, element('h2', system.name), element('p', system.description), go);
        card.append(art, body);
        items.append(card);
      }
      return;
    }
    for (const game of catalog.games.filter((game) => game.system === system.id)) {
      const card = element('article');
      card.className = 'card';
      const art = element('div');
      art.className = 'art';
      if (game.image) {
        const image = element('img');
        image.src = url(game.image);
        image.alt = '';
        image.loading = 'lazy';
        art.append(image);
      } else {
        const symbol = element('span', '▦');
        symbol.className = 'symbol';
        art.append(symbol);
      }
      const body = element('div');
      body.className = 'card-body';
      const meta = element('span', game.status.toUpperCase());
      meta.className = 'meta';
      const actions = element('div');
      actions.className = 'card-actions';
      if (game.runnable) {
        actions.append(link(playLabel(game), `${system.id}/${game.id}`, 'play-link'));
      }
      actions.append(link('Learn', `${system.id}/${game.id}/learn`));
      body.append(meta, element('h2', game.name), actions);
      card.append(art, body);
      items.append(card);
    }
  }
  historyRouter(base, render);
} catch (error) {
  heading.textContent = 'The library could not load.';
  description.textContent = error instanceof Error ? error.message : String(error);
}

// Keyboard events do not bubble out of an iframe. Forward keys that arrive at
// the library body so clicking navigation or the surrounding frame cannot
// silently strand game input in the parent document.
const gameKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Enter',
  'KeyZ',
  'KeyX',
  'ShiftRight',
  'Digit8',
  'Numpad8',
  'Delete',
  'Backspace',
]);
for (const type of ['keydown', 'keyup'] as const) {
  document.addEventListener(type, (event) => {
    if (!document.body.classList.contains('playing')) {
      return;
    }
    const gameFrame = document.querySelector('iframe');
    const actionCodes = Array.from(
      gameFrame?.contentDocument?.querySelectorAll<HTMLElement>('[data-keycode]') ?? [],
    ).map((button) => button.dataset.keycode);
    if (!gameKeys.has(event.code) && !actionCodes.includes(event.code)) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('a,button,input,textarea,select')) {
      return;
    }
    const frame = document.querySelector('iframe');
    if (!frame?.contentWindow) {
      return;
    }
    event.preventDefault();
    frame.contentWindow.postMessage(
      {
        type: 'rom-studio-key',
        code: event.code,
        key: event.key,
        down: type === 'keydown',
        repeat: event.repeat,
      },
      location.origin,
    );
  });
}

window.addEventListener('blur', () => {
  const frame = document.querySelector('iframe');
  const actionCodes = Array.from(
    frame?.contentDocument?.querySelectorAll<HTMLElement>('[data-keycode]') ?? [],
  )
    .map((button) => button.dataset.keycode!)
    .filter(Boolean);
  for (const code of new Set([...gameKeys, ...actionCodes])) {
    frame?.contentWindow?.postMessage(
      { type: 'rom-studio-key', code, key: code, down: false },
      location.origin,
    );
  }
});
