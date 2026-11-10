import type { SourceObservation } from '../../contracts.js';
import { instructionTypeScript } from '../library/code.js';
import type { DeskSymbol } from './types.js';

/** Observed instruction variants for one processor. Small games inline them;
 * SM64 pages them in address order, so a lookup fetches only the pages a
 * binary search needs. */
export class ObservationIndex {
  private inline: SourceObservation[] = [];
  private parts: string[] = [];
  private readonly pages = new Map<number, Promise<SourceObservation[]>>();
  private readonly sources = new Map<string, Promise<string>>();
  scope = '';
  private constructor(
    readonly directory: string,
    private readonly request: typeof fetch,
  ) {}
  static async load(
    directory: string,
    // Wrapped: a bare `fetch` stored on an object throws "Illegal invocation".
    request: typeof fetch = (input, init) => fetch(input, init),
  ): Promise<ObservationIndex> {
    const index = new ObservationIndex(directory, request);
    const response = await request(directory + 'observed-source.json');
    if (!response.ok) {
      throw new Error('This package has no code observations.');
    }
    const value = (await response.json()) as {
      mappings?: SourceObservation[];
      parts?: string[];
      scope?: string;
    };
    if (
      !Array.isArray(value.mappings) ||
      (value.parts !== undefined &&
        (!Array.isArray(value.parts) ||
          value.parts.length > 4096 ||
          value.parts.some((part) => !/^observations\/[0-9a-f]{4}\.json$/.test(part))))
    ) {
      throw new Error('Invalid code observation index.');
    }
    index.inline = value.mappings;
    index.parts = value.parts ?? [];
    index.scope = value.scope ?? '';
    return index;
  }
  private page(index: number): Promise<SourceObservation[]> {
    if (!this.pages.has(index)) {
      this.pages.set(
        index,
        this.request(this.directory + this.parts[index]!).then(async (response) => {
          if (!response.ok) {
            throw new Error('A code observation page is unavailable.');
          }
          const values: unknown = await response.json();
          if (!Array.isArray(values)) {
            throw new Error('Invalid code observation page.');
          }
          return values as SourceObservation[];
        }),
      );
    }
    return this.pages.get(index)!;
  }
  /** Every observed variant at this address (one per opcode). */
  async at(address: number): Promise<SourceObservation[]> {
    const matches = this.inline.filter((item) => item.address === address);
    let low = 0,
      high = this.parts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1,
        page = await this.page(middle);
      if (!page.length || address < page[0]!.address) {
        high = middle - 1;
      } else if (address > page[page.length - 1]!.address) {
        low = middle + 1;
      } else {
        matches.push(...page.filter((item) => item.address === address));
        // Variants of one address may straddle a page boundary.
        const edges = [
          address === page[0]!.address ? middle - 1 : -1,
          address === page[page.length - 1]!.address ? middle + 1 : -1,
        ];
        for (const neighbour of edges) {
          if (neighbour >= 0 && neighbour < this.parts.length) {
            matches.push(...(await this.page(neighbour)).filter((i) => i.address === address));
          }
        }
        break;
      }
    }
    return matches;
  }
  /** The generated TypeScript function the dispatcher runs for this exact
   * address and opcode, read from the package's source page. */
  async generated(address: number, opcode: number, sourceFile = 'program.ts'): Promise<string> {
    if (!/^(?:program\.ts|pages\/[0-9a-f]{4}(?:[0-9a-f]{4})?\.ts)$/.test(sourceFile)) {
      throw new Error('Invalid source page.');
    }
    if (!this.sources.has(sourceFile)) {
      this.sources.set(
        sourceFile,
        this.request(this.directory + sourceFile).then(async (response) => {
          if (!response.ok) {
            throw new Error('The generated source page is unavailable.');
          }
          return response.text();
        }),
      );
    }
    return instructionTypeScript(await this.sources.get(sourceFile)!, address, opcode);
  }
}

/** Source page holding `address` when observations do not name one: the
 * dispatcher's page naming (4 hex digits for 6502 pages, 8 for VR4300). */
export function sourcePageFor(address: number, wide: boolean): string {
  return wide
    ? `pages/${(((address >>> 12) << 12) >>> 0).toString(16).padStart(8, '0')}.ts`
    : `pages/${((address >>> 12) << 12).toString(16).padStart(4, '0')}.ts`;
}

export async function loadSymbols(
  url: string,
  request: typeof fetch = fetch,
): Promise<DeskSymbol[]> {
  const response = await request(url);
  if (!response.ok) {
    return [];
  }
  const value = (await response.json()) as { schemaVersion?: number; symbols?: unknown };
  if (value.schemaVersion !== 1 || !Array.isArray(value.symbols)) {
    throw new Error('Invalid Desk symbol file.');
  }
  return (value.symbols as DeskSymbol[]).filter(
    (symbol) =>
      Number.isSafeInteger(symbol.start) &&
      Number.isSafeInteger(symbol.end) &&
      symbol.start <= symbol.end &&
      typeof symbol.name === 'string' &&
      typeof symbol.evidence === 'string',
  );
}

/** The narrowest named range containing `address`. */
export function symbolAt(symbols: readonly DeskSymbol[], address: number): DeskSymbol | undefined {
  let best: DeskSymbol | undefined;
  for (const symbol of symbols) {
    if (
      address >= symbol.start &&
      address <= symbol.end &&
      (!best || symbol.end - symbol.start < best.end - best.start)
    ) {
      best = symbol;
    }
  }
  return best;
}
