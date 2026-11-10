import type { BrowserTitle } from './shell-types.js';
/** Load the one title adapter declared by this verified static package. The
 * shell has no game-specific branches or imports. */
export async function browserTitle(entry: string): Promise<BrowserTitle> {
  if (!/^\.\.\/games\/[a-z0-9-]+\/[a-z0-9-]+\/web\/title\.js$/.test(entry)) {
    throw new Error('Invalid browser title module.');
  }
  const module = (await import(entry)) as { title: BrowserTitle };
  return module.title;
}
