/** A checked replay is evidence for a route. It does not promote a partial
 * recovery to a public game. Source evidence can still be used in Learn. */
export function gameDelivery(status: string, includeStudies = false) {
  const experimental = status !== 'release-ready';
  const runtime = !experimental || includeStudies;
  return {
    experimental,
    runtime,
    includes(relative: string): boolean {
      return (
        runtime ||
        (relative.startsWith('game-code/') && relative.endsWith('.ts')) ||
        /^game-code\/(?:[a-z0-9-]+\/)?observed-source\.json$/.test(relative) ||
        /^game-code\/(?:[a-z0-9-]+\/)?observations\/[0-9a-f]{4}\.json$/.test(relative) ||
        relative === 'reference-final.png' ||
        relative.startsWith('learn/')
      );
    },
  };
}
import { Diagnostic } from '../contracts.js';

/** A release build must contain every registered game's accepted play scope.
 * Learn-only or explicitly experimental exports are development artifacts. */
export function requireReadyGames(
  games: readonly { id: string; runnable: boolean; experimental: boolean }[],
): void {
  const unfinished = games.filter((game) => !game.runnable || game.experimental);
  if (unfinished.length) {
    throw new Diagnostic(
      'RELEASE_GAMES',
      `v0.1 requires every target game working. Unfinished: ${unfinished.map((game) => game.id).join(', ')}. Use dev for ongoing recovery; this is not a release build.`,
    );
  }
}
