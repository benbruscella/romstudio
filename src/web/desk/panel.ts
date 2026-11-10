import { ObservationIndex, loadSymbols, sourcePageFor, symbolAt } from './observations.js';
import { systemDiagram } from './diagram.js';
import type { DeskProcessorState, DeskState, DeskSymbol, DeskTarget } from './types.js';

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
};
const hex = (value: number, width: number) =>
  (value >>> 0).toString(16).toUpperCase().padStart(width, '0');

/** Parse "$1234", "0x80246000", "1234" (hex) or a routine name. */
export function parseDeskAddress(
  text: string,
  symbols: readonly DeskSymbol[],
  limit: number,
): number | undefined {
  const value = text.trim();
  const named = symbols.find((symbol) => symbol.name.toLowerCase() === value.toLowerCase());
  if (named) {
    return named.start;
  }
  const digits = value.replace(/^(?:\$|0x)/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(digits)) {
    return undefined;
  }
  const address = Number.parseInt(digits, 16);
  return address < limit ? address : undefined;
}

/** The ROM Desk panel. It only renders what the target reports and sends its
 * commands; execution belongs to the target's real system adapter. */
export async function createDesk(
  root: HTMLElement,
  target: DeskTarget,
  options: { symbolsUrl: string },
): Promise<{ refresh(): Promise<void>; close(): Promise<void> }> {
  const wide = target.system === 'n64',
    width = wide ? 8 : 4,
    limit = wide ? 2 ** 32 : 65536;
  // Pause first: the game must not run on while the panel loads.
  const opened = target.open();
  const symbols = await loadSymbols(options.symbolsUrl).catch(() => []);
  const indexes = new Map<string, Promise<ObservationIndex | undefined>>();
  const index = (directory: string) => {
    if (!indexes.has(directory)) {
      indexes.set(
        directory,
        ObservationIndex.load(directory).catch(() => undefined),
      );
    }
    return indexes.get(directory)!;
  };
  const breakpoints = new Set<number>();
  let busy = false,
    running = false,
    version = 0;

  root.replaceChildren();
  root.classList.add('desk');
  const header = element('div', undefined, 'desk-header');
  const title = element('h2', 'ROM Desk');
  const tier = element('p', '', 'desk-tier');
  header.append(title, tier);
  const controls = element('div', undefined, 'desk-controls');
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', 'Desk controls');
  const status = element('p', '', 'desk-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const processors = element('div', undefined, 'desk-processors');
  const counters = element('dl', undefined, 'desk-counters');

  // Breakpoints
  const breakSection = element('section', undefined, 'desk-card');
  breakSection.append(element('h3', 'Breakpoints'));
  const breakForm = element('form', undefined, 'desk-inline');
  const breakInput = element('input');
  breakInput.placeholder = wide ? '80246000 or routine name' : '$8000 or routine name';
  breakInput.setAttribute('aria-label', 'Breakpoint address or routine name');
  breakInput.setAttribute('list', 'desk-symbols');
  const symbolList = element('datalist');
  symbolList.id = 'desk-symbols';
  for (const symbol of symbols) {
    const option = element('option');
    option.value = symbol.name;
    option.label = '$' + hex(symbol.start, width);
    symbolList.append(option);
  }
  const breakAdd = element('button', 'Add');
  breakAdd.type = 'submit';
  breakForm.append(breakInput, breakAdd, symbolList);
  const breakList = element('ul', undefined, 'desk-breakpoints');
  breakSection.append(breakForm, breakList);

  // Memory
  const memorySection = element('section', undefined, 'desk-card desk-memory');
  memorySection.append(element('h3', 'Memory'));
  const memoryForm = element('form', undefined, 'desk-inline');
  const space = element('select');
  space.setAttribute('aria-label', 'Memory space');
  for (const item of target.memory) {
    const option = element('option', item.label);
    option.value = item.id;
    space.append(option);
  }
  const memoryInput = element('input');
  memoryInput.setAttribute('aria-label', 'Memory address');
  const previous = element('button', '◀');
  previous.type = 'button';
  previous.setAttribute('aria-label', 'Previous 256 bytes');
  const next = element('button', '▶');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next 256 bytes');
  const go = element('button', 'Show');
  go.type = 'submit';
  memoryForm.append(space, memoryInput, go, previous, next);
  const dump = element('pre', '', 'desk-dump');
  dump.setAttribute('aria-label', 'Memory contents');
  memorySection.append(
    memoryForm,
    dump,
    element('p', 'Read without side effects; device registers show as --.', 'desk-note'),
  );
  let memoryAddress = target.memory[0]?.start ?? 0;
  memoryInput.value = hex(memoryAddress, width);

  const diagram = element('details', undefined, 'desk-card');
  diagram.append(element('summary', 'System diagram'), systemDiagram(target.system));

  root.append(header, controls, status, processors, counters, breakSection, memorySection, diagram);

  const button = (label: string, titleText: string, action: () => Promise<void>) => {
    const node = element('button', label);
    node.type = 'button';
    node.title = titleText;
    node.addEventListener('click', () => {
      void action();
    });
    controls.append(node);
    return node;
  };
  const guarded = async (work: () => Promise<DeskState | undefined>) => {
    if (busy) {
      return;
    }
    busy = true;
    controls.setAttribute('aria-busy', 'true');
    try {
      const state = await work();
      if (state) {
        await show(state);
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      controls.removeAttribute('aria-busy');
    }
  };
  for (const step of target.steps) {
    button(step.label, step.title, () => guarded(() => target.step(step.kind)));
  }
  const runButton = button('Run', 'Run until a breakpoint (at most 3000 frames)', async () => {
    if (running) {
      target.interrupt();
      return;
    }
    running = true;
    runButton.textContent = 'Pause';
    status.textContent = breakpoints.size ? 'Running to a breakpoint…' : 'Running…';
    try {
      await guarded(() => target.run({ breakpoints: [...breakpoints], frames: 3000 }));
    } finally {
      running = false;
      runButton.textContent = 'Run';
    }
  });
  button('Restart', 'Restart from the launch checkpoint, paused', () =>
    guarded(() => target.restart()),
  );

  const renderBreakpoints = () => {
    breakList.replaceChildren();
    for (const address of [...breakpoints].sort((a, b) => a - b)) {
      const item = element('li');
      const name = symbolAt(symbols, address);
      item.append(element('code', '$' + hex(address, width)));
      if (name) {
        item.append(' ' + name.name);
      }
      const remove = element('button', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove breakpoint at ${hex(address, width)}`);
      remove.addEventListener('click', () => {
        breakpoints.delete(address);
        renderBreakpoints();
      });
      item.append(remove);
      breakList.append(item);
    }
    if (!breakpoints.size) {
      breakList.append(element('li', 'None. Add an address or a named routine.', 'desk-note'));
    }
  };
  breakForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = parseDeskAddress(breakInput.value, symbols, limit);
    if (address === undefined) {
      status.textContent = 'Enter a hexadecimal address or a listed routine name.';
      return;
    }
    breakpoints.add(address);
    breakInput.value = '';
    renderBreakpoints();
  });
  renderBreakpoints();

  const showMemory = async () => {
    const values = await target.read(space.value, memoryAddress, 256);
    const lines: string[] = [];
    for (let row = 0; row < 16; row++) {
      const bytes = values.slice(row * 16, row * 16 + 16);
      lines.push(
        hex(memoryAddress + row * 16, width) +
          '  ' +
          bytes.map((byte) => (byte === undefined ? '--' : hex(byte, 2))).join(' ') +
          '  ' +
          bytes
            .map((byte) =>
              byte !== undefined && byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.',
            )
            .join(''),
      );
    }
    dump.textContent = lines.join('\n');
  };
  memoryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = parseDeskAddress(memoryInput.value, symbols, limit);
    if (address === undefined) {
      status.textContent = 'Enter a hexadecimal memory address.';
      return;
    }
    memoryAddress = address & ~15;
    void showMemory();
  });
  for (const [control, delta] of [
    [previous, -256],
    [next, 256],
  ] as const) {
    control.addEventListener('click', () => {
      memoryAddress = Math.max(0, Math.min(limit - 256, memoryAddress + delta));
      memoryInput.value = hex(memoryAddress, width);
      void showMemory();
    });
  }
  space.addEventListener('change', () => {
    const selected = target.memory.find((item) => item.id === space.value);
    memoryAddress = selected?.start ?? 0;
    memoryInput.value = hex(memoryAddress, width);
    void showMemory();
  });

  const processorCard = async (state: DeskProcessorState, current: number) => {
    const card = element('section', undefined, 'desk-card desk-processor');
    card.append(element('h3', state.label));
    const location = element('p', undefined, 'desk-location');
    location.append(element('code', '$' + hex(state.pc, state.id === 'rsp' ? 3 : width)));
    location.append(' · ' + state.identity);
    card.append(location);
    if (state.note) {
      card.append(element('p', state.note, 'desk-note'));
    }
    const symbol = state.id === 'cpu' ? symbolAt(symbols, state.pc) : undefined;
    if (symbol) {
      const named = element('p', undefined, 'desk-symbol');
      named.append(element('strong', symbol.name));
      named.append(
        ` ($${hex(symbol.start, width)}${symbol.end !== symbol.start ? '–$' + hex(symbol.end, width) : ''}) — ${symbol.detail} `,
      );
      named.append(element('span', `Evidence: ${symbol.evidence}`, 'desk-note'));
      if (symbol.epoch || symbol.bank) {
        named.append(element('span', ` Applies to ${symbol.epoch ?? symbol.bank}.`, 'desk-note'));
      }
      card.append(named);
    }
    const original = element('pre', 'Looking up the observed instruction…', 'desk-original');
    original.setAttribute('aria-label', 'Original instruction');
    const generated = element('pre', '', 'desk-generated');
    generated.setAttribute('aria-label', 'Generated TypeScript');
    card.append(
      element('h4', 'Original'),
      original,
      element('h4', 'Generated TypeScript'),
      generated,
    );
    const registers = element('dl', undefined, 'desk-registers');
    for (const register of state.registers) {
      const term = element('dt', register.name),
        value = element('dd', register.value);
      if (register.title) {
        value.title = register.title;
      }
      registers.append(term, value);
    }
    card.append(registers);
    if (state.flags) {
      const flags = element('p', undefined, 'desk-flags');
      flags.setAttribute('aria-label', 'Status flags');
      for (const flag of state.flags) {
        const chip = element('span', flag.name, flag.set ? 'set' : '');
        chip.title = `${flag.title}: ${flag.set ? 'set' : 'clear'}`;
        flags.append(chip);
      }
      card.append(flags);
    }
    void (async () => {
      const observations = await index(state.sourceDirectory);
      if (current !== version) {
        return;
      }
      const live = state.bytes.map((byte) => hex(byte, 2)).join(' ');
      if (!observations || state.opcode === undefined) {
        original.textContent = state.bytes.length
          ? `${hex(state.pc, width)}  ${live}  (no observations in this package)`
          : 'The PC is not in readable memory.';
        return;
      }
      const variants = await observations.at(state.pc);
      if (current !== version) {
        return;
      }
      const match = variants.find((item) => item.opcode === state.opcode);
      const liveLength = match ? match.bytes.length : wide ? 4 : 1;
      const liveBytes = state.bytes.slice(0, liveLength);
      if (match) {
        const same = match.bytes.every((byte, offset) => byte === liveBytes[offset]);
        original.textContent =
          `${hex(state.pc, width)}  ${liveBytes.map((b) => hex(b, 2)).join(' ')}  ${match.assembly}` +
          (same
            ? ''
            : `\nOperand bytes differ from the first observed variant (${match.bytes.map((b) => hex(b, 2)).join(' ')}); the listing shows that variant.`) +
          (variants.length > 1
            ? `\n${variants.length} observed variants at this address: code loaded at different times (self-modifying code, another bank, epoch or microcode).`
            : '');
      } else {
        original.textContent =
          `${hex(state.pc, width)}  ${liveBytes.map((b) => hex(b, 2)).join(' ')}` +
          (variants.length
            ? `\nThese live bytes differ from every observed variant here (${variants.map((item) => item.assembly).join('; ')}).`
            : '\nNo observed instruction at this address.');
      }
      const file =
        match?.sourceFile ??
        variants[0]?.sourceFile ??
        (state.id === 'cpu' ? sourcePageFor(state.pc, wide) : 'program.ts');
      try {
        generated.textContent = await observations.generated(state.pc, state.opcode, file);
      } catch {
        try {
          generated.textContent = await observations.generated(state.pc, state.opcode);
        } catch (error) {
          generated.textContent = String(error);
        }
      }
    })();
    return card;
  };

  const show = async (state: DeskState) => {
    const current = ++version;
    tier.textContent = `Tier: ${state.tier} · frame ${state.frame.toLocaleString()}`;
    status.textContent = [state.last, state.gap].filter(Boolean).join(' ');
    const cards = await Promise.all(state.processors.map((item) => processorCard(item, current)));
    if (current !== version) {
      return;
    }
    processors.replaceChildren(...cards);
    counters.replaceChildren();
    for (const counter of state.counters) {
      counters.append(element('dt', counter.name), element('dd', counter.value));
    }
    await showMemory();
  };

  await guarded(() => opened);
  return {
    refresh: () => guarded(() => target.state()),
    async close() {
      target.interrupt();
      await target.close();
    },
  };
}
