import { Diagnostic } from './contracts.js';

/** A port owns different original code and media, even when its name matches. */
export interface GameIdentity {
  system: string;
  id: string;
}
export type GameKey = `${string}/${string}`;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function gameKey(system: string, id: string): GameKey {
  if (!slug.test(system) || !slug.test(id)) {
    throw new Diagnostic('GAME_ID', 'Use system/game slugs, for example nes/tetris.');
  }
  return `${system}/${id}`;
}
export function gameIdentity(key: string): GameIdentity {
  const [system, id, extra] = key.split('/');
  if (!system || !id || extra !== undefined) {
    throw new Diagnostic('GAME_ID', 'Choose a platform version using system/game.');
  }
  gameKey(system, id);
  return { system, id };
}
export function resolveGameKey(
  selection: string,
  available: readonly GameIdentity[],
  system?: string,
): GameKey {
  const wanted = selection.includes('/') ? gameIdentity(selection) : undefined;
  const matches = available.filter(
    (game) =>
      (wanted ? game.id === wanted.id && game.system === wanted.system : game.id === selection) &&
      (!system || game.system === system),
  );
  if (matches.length === 1) {
    return gameKey(matches[0]!.system, matches[0]!.id);
  }
  const choices = (matches.length ? matches : available)
    .map((game) => gameKey(game.system, game.id))
    .join(', ');
  throw new Diagnostic(
    'GAME_ID',
    matches.length
      ? `Game '${selection}' exists on multiple systems. Choose ${choices}.`
      : `Unknown game '${selection}'. Choose ${choices}.`,
  );
}
