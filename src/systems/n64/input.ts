/** Browser intent mapped onto the standard N64 controller, sampled by SI.
 * Short press/release pairs survive until two actual controller polls see
 * them. Worker scheduling cannot turn a quick tap into a missing input. */
export interface N64Input {
  pressed: readonly string[];
  stickX?: number;
  stickY?: number;
}

export class N64Controls {
  private held = new Set<string>();
  private readonly latched = new Map<string, number>();
  private x = 0;
  private y = 0;
  polls = 0;

  clear(): void {
    this.held.clear();
    this.latched.clear();
    this.x = this.y = 0;
  }

  update(input: N64Input): void {
    const next = new Set(input.pressed);
    for (const code of next) {
      if (!this.held.has(code)) {
        this.latched.set(code, this.polls + 2);
      }
    }
    this.held = next;
    this.x = Math.max(-80, Math.min(80, Math.round(input.stickX ?? 0)));
    this.y = Math.max(-80, Math.min(80, Math.round(input.stickY ?? 0)));
  }
  sample() {
    this.polls++;
    const keys = new Set(this.held);
    for (const [code, until] of this.latched) {
      if (this.polls <= until) {
        keys.add(code);
      } else {
        this.latched.delete(code);
      }
    }
    let buttons = 0;
    for (const [code, bit] of [
      ['Space', 0x8000],
      ['KeyZ', 0x8000],
      ['KeyX', 0x4000],
      ['ShiftLeft', 0x2000],
      ['Enter', 0x1000],
      ['ShiftRight', 0x10],
      ['KeyI', 8],
      ['KeyK', 4],
      ['KeyJ', 2],
      ['KeyL', 1],
    ] as const) {
      if (keys.has(code)) {
        buttons |= bit;
      }
    }
    return {
      buttons,
      stickX: keys.has('ArrowLeft') ? -80 : keys.has('ArrowRight') ? 80 : this.x,
      stickY: keys.has('ArrowUp') ? 80 : keys.has('ArrowDown') ? -80 : this.y,
    };
  }
}
