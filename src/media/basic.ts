import { Diagnostic } from '../core.js';
export interface BasicSys {
  line: number;
  expression: string;
  entry: number;
  tokenBytes: number[];
}
/** Bounded parser for the explicitly supported SYS expression forms; never evals source input. */
export function basicSys(memory: Uint8Array, start: number): BasicSys {
  let address = start;
  const seen = new Set<number>();
  for (let count = 0; count < 256; count++) {
    if (address < 0 || address + 4 >= memory.length || seen.has(address)) {
      throw new Diagnostic('BASIC_LINK', 'Invalid or cyclic BASIC line link.');
    }
    seen.add(address);
    const next = memory[address]! | (memory[address + 1]! << 8);
    if (next === 0) {
      break;
    }
    if (next <= address + 4 || next + 1 >= memory.length) {
      throw new Diagnostic('BASIC_LINK', 'BASIC line link is outside the program.');
    }
    const line = memory[address + 2]! | (memory[address + 3]! << 8);
    let end = address + 4;
    while (end < next && memory[end] !== 0) {
      end++;
    }
    if (end === next) {
      throw new Diagnostic('BASIC_LINE', 'Unterminated BASIC line.');
    }
    const tokens = [...memory.subarray(address + 4, end)].filter((b) => b !== 0x20);
    if (tokens[0] === 0x9e) {
      const tokenBytes = tokens.slice(1);
      const expression = tokenBytes
        .map((b) => (b === 0xff ? 'π' : b === 0xac ? '*' : String.fromCharCode(b)))
        .join('');
      let value: number;
      if (/^\d+$/.test(expression)) {
        value = Number(expression);
      }
      // This title's expression has a reviewed integer result. General BASIC
      // floating point and expression evaluation need a separate implementation.
      else if (expression === 'π*656') {
        value = 2060;
      } else {
        throw new Diagnostic(
          'BASIC_EXPRESSION',
          `Unsupported SYS expression '${expression}'; provide a reviewed entry point.`,
        );
      }
      const entry = Math.trunc(value);
      if (!Number.isFinite(value) || entry < 0 || entry > 65535) {
        throw new Diagnostic('BASIC_SYS_RANGE', 'SYS target must fit a 16-bit address.');
      }
      return { line, expression, entry, tokenBytes: [0x9e, ...tokenBytes] };
    }
    address = next;
  }
  throw new Diagnostic('BASIC_NO_SYS', 'No supported SYS entry point found.');
}
