/** Browser intent, before a system maps keys to joystick pins or serial pads. */
export interface BrowserControls {
  pressed: readonly string[];
}
export const idleBrowserControls = (): BrowserControls => ({ pressed: [] });
