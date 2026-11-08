/** Interpretation of $ABCB–$ABE7 in the pinned PAL PRG. The game samples the
 * pad twice, retains only buttons present in both samples, and reports newly
 * pressed buttons separately from those still held. Values use the game's
 * shifted bit order (A in bit 7), not the host controller's serial order. */
export function stableButtons(first: number, second: number, previousHeld: number) {
  for (const value of [first, second, previousHeld]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('Controller samples must be bytes.');
    }
  }
  const held = first & second;
  return { held, pressed: held & ~previousHeld };
}
