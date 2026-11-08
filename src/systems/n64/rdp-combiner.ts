/** A draw packet holds its muxes constant. Resolve selectors once into
 * scratch-register indices; evaluate pixels without closures or RGBA tuples.
 * This preserves the scalar functional combiner, including its skipped inputs
 * and errors. It does not change the documented hardware precision. */
export class PreparedRdpCombiner {
  // combined, texel, primitive, shade, environment, LOD, zero, one (256).
  readonly sources = new Float64Array(23);
  readonly output = new Uint8Array(4);
  /** One-cycle RGB pass-through, with every evaluated selector supported.
   * Alpha still follows its independent equation. */
  readonly directRgb: 4 | 12 | undefined;
  private readonly equations = new Int16Array(32);
  private readonly multiply = new Uint8Array(8);
  private error: string | undefined;
  private readonly first: number;

  constructor(
    words: Uint32Array,
    cycleType: number,
    private readonly unsupported: (kind: string, detail: string) => never,
  ) {
    this.first = cycleType === 1 ? 0 : 4;
    this.sources[20] = words[116]! & 255;
    this.sources[22] = 256;
    for (const [register, base] of [
      [117, 8],
      [119, 16],
    ] as const) {
      const color = words[register]!;
      for (let c = 0; c < 4; c++) {
        this.sources[base + c] = (color >>> (24 - c * 8)) & 255;
      }
    }
    const high = words[120]!,
      low = words[121]!;
    const fail = (detail: string): number => {
      this.error ??= detail;
      return 21;
    };
    const rgba = (selector: number, component: number): number =>
      selector === 2
        ? fail('A second texture/LOD sample is not implemented.')
        : (selector > 2 ? selector - 1 : selector) * 4 + component;
    const rgb = (selector: number, slot: 'a' | 'b' | 'c' | 'd', component: number): number => {
      if (selector < 6) {
        // Selector 2 is unsupported, so the unused register gap is omitted.
        return rgba(selector, component);
      }
      if (slot === 'd') {
        return selector === 6 ? 22 : 21;
      }
      if (slot === 'c') {
        if (selector >= 7 && selector <= 12) {
          const source = selector - 7;
          return source === 2
            ? fail('A second texture/LOD sample is not implemented.')
            : (source > 2 ? source - 1 : source) * 4 + 3;
        }
        if (selector === 14) {
          return 20;
        }
        if (selector >= 16) {
          return 21;
        }
      } else {
        if (selector >= 8) {
          return 21;
        }
        if (slot === 'a' && selector === 6) {
          return 22;
        }
      }
      return fail(`RGB ${slot} input ${selector} (key/noise/conversion/LOD) is not implemented.`);
    };
    const alpha = (selector: number, multiplier = false): number => {
      if (multiplier && selector === 0) {
        return fail('Texture LOD alpha is not implemented.');
      }
      if (selector < 6) {
        return selector === 2
          ? fail('A second texture/LOD sample is not implemented.')
          : (selector > 2 ? selector - 1 : selector) * 4 + 3;
      }
      return selector === 7 ? 21 : multiplier ? 20 : 22;
    };
    for (let cycle = this.first / 4; cycle < 2; cycle++) {
      const a = cycle === 0 ? (high >>> 20) & 15 : (high >>> 5) & 15,
        b = cycle === 0 ? (low >>> 28) & 15 : (low >>> 24) & 15,
        c = cycle === 0 ? (high >>> 15) & 31 : high & 31,
        d = cycle === 0 ? (low >>> 15) & 7 : (low >>> 6) & 7,
        aa = cycle === 0 ? (high >>> 12) & 7 : (low >>> 21) & 7,
        ab = cycle === 0 ? (low >>> 12) & 7 : (low >>> 3) & 7,
        ac = cycle === 0 ? (high >>> 9) & 7 : (low >>> 18) & 7,
        ad = cycle === 0 ? (low >>> 9) & 7 : low & 7;
      for (let component = 0; component < 3; component++) {
        const eq = cycle * 4 + component,
          offset = eq * 4;
        // The scalar reference evaluates D before A/B/C, even on errors.
        this.equations[offset + 3] = rgb(d, 'd', component);
        if (a !== b && c < 16) {
          this.multiply[eq] = 1;
          this.equations[offset] = rgb(a, 'a', component);
          this.equations[offset + 1] = rgb(b, 'b', component);
          this.equations[offset + 2] = rgb(c, 'c', component);
        }
      }
      const eq = cycle * 4 + 3,
        offset = eq * 4;
      if (aa !== ab && ac !== 7) {
        this.multiply[eq] = 1;
        this.equations[offset] = alpha(aa);
        this.equations[offset + 1] = alpha(ab);
        this.equations[offset + 2] = alpha(ac, true);
      }
      this.equations[offset + 3] = alpha(ad);
    }
    const source = this.equations[19]!;
    this.directRgb =
      !this.error &&
      this.first === 4 &&
      !this.multiply[4] &&
      !this.multiply[5] &&
      !this.multiply[6] &&
      (source === 4 || source === 12) &&
      this.equations[23] === source + 1 &&
      this.equations[27] === source + 2
        ? source
        : undefined;
  }

  /** Used only for the proven direct-RGB mode. Alpha muxes never read RGB;
   * no RGB scratch values or unused shade components need to be prepared. */
  evaluateDirectAlpha(texel: number, shade: number): number {
    const s = this.sources,
      eq = this.equations;
    s[3] = 0;
    s[7] = texel;
    s[15] = shade;
    const value = this.multiply[7]
      ? ((s[eq[28]!]! - s[eq[29]!]!) * s[eq[30]!]!) / 256 + s[eq[31]!]! + 0.5
      : s[eq[31]!]!;
    return Math.max(0, Math.min(255, Math.floor(value)));
  }

  evaluate(): Uint8Array {
    if (this.error) {
      return this.unsupported('rdp-combiner', this.error);
    }
    const s = this.sources,
      eq = this.equations,
      out = this.output;
    s[0] = s[1] = s[2] = s[3] = 0;
    for (let cycle = this.first; cycle < 8; cycle += 4) {
      for (let component = 0; component < 4; component++) {
        const i = cycle + component,
          p = i * 4;
        const value = this.multiply[i]
          ? ((s[eq[p]!]! - s[eq[p + 1]!]!) * s[eq[p + 2]!]!) / 256 + s[eq[p + 3]!]! + 0.5
          : s[eq[p + 3]!]!;
        out[component] = Math.max(0, Math.min(255, Math.floor(value)));
      }
      // RGB and alpha in one cycle read the same previous combined value.
      s[0] = out[0]!;
      s[1] = out[1]!;
      s[2] = out[2]!;
      s[3] = out[3]!;
    }
    return out;
  }
}
