export interface LibraryRoute {
  system?: string;
  game?: string;
  view: 'play' | 'learn';
  chapter?: string;
}

/** Paths are relative to the static-host base. No hash stores route state. */
export function libraryRoute(pathname: string, base: string): LibraryRoute | undefined {
  if (!pathname.startsWith(base)) {
    return undefined;
  }
  let parts: string[];
  try {
    parts = decodeURIComponent(pathname.slice(base.length)).split('/').filter(Boolean);
  } catch {
    return undefined;
  }
  if (
    parts.some((part) => !/^[a-z0-9-]+$/.test(part)) ||
    parts.length > 4 ||
    (parts.length > 2 && parts[2] !== 'learn')
  ) {
    return undefined;
  }
  return {
    view: parts[2] === 'learn' ? 'learn' : 'play',
    ...(parts[0] ? { system: parts[0] } : {}),
    ...(parts[1] ? { game: parts[1] } : {}),
    ...(parts[3] ? { chapter: parts[3] } : {}),
  };
}

export function historyRouter(base: string, render: () => void): void {
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.target ||
      anchor.hasAttribute('download')
    ) {
      return;
    }
    const target = new URL(anchor.href);
    if (target.origin !== location.origin || target.hash || !libraryRoute(target.pathname, base)) {
      return;
    }
    event.preventDefault();
    history.pushState(null, '', target);
    render();
    window.scrollTo(0, 0);
  });
  addEventListener('popstate', render);
  render();
}
