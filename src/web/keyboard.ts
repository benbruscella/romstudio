/** Browser names differ for the Mac key labelled Delete and a forward Delete
 * key. Normalize host keys here; machine matrix wiring stays in the system. */
export function browserKey(event: { code: string; key: string }): string {
  if (event.code === 'Backspace' || event.key === 'Backspace') {
    return 'Delete';
  }
  if (event.code === 'Numpad8' || event.key === '8') {
    return 'Digit8';
  }
  if (event.code) {
    return event.code;
  }
  if (event.key === ' ') {
    return 'Space';
  }
  return event.key;
}
