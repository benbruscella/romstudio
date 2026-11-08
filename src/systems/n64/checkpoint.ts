import type { N64System } from './system.js';

export type N64Checkpoint = ReturnType<N64System['snapshot']>;

/** Transfer histories explain recovery, but are not architectural state.
 * Browser sessions keep these bounded without changing registers, memories,
 * pending DMA, interrupts, sample counters or processor clock phase. */
export function clearN64Trace(system: N64System): void {
  const m = system.memory;
  m.accesses.length = 0;
  m.peripheral.transfers.length = 0;
  m.signal.transfers.length = 0;
  m.display.commands.length = 0;
  m.display.fills.length = 0;
  m.display.triangles.length = 0;
  m.display.texture.loads.length = 0;
}

export function compactN64Checkpoint(system: N64System): N64Checkpoint {
  const state = system.snapshot(),
    m = state.devices;
  m.accesses = [];
  m.peripheral.transfers = [];
  m.signal.transfers = [];
  m.display.commands = [];
  m.display.fills = [];
  m.display.triangles = [];
  m.display.texture.loads = [];
  return state;
}

export interface N64Launch {
  schemaVersion: 1;
  state: N64Checkpoint;
  assets: { cartridge: string; rdram: string; signal: string };
  cartridgeSha256: string;
  width: number;
  height: number;
}
