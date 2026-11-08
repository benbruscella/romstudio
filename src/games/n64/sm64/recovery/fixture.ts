import { N64System } from '../../../../systems/n64/system.js';
import { sm64Entry } from '../code/startup.js';

/** Declared post-IPL3 fixture. The cartridge boot program, PIF/CIC handshake
 * and physical RDRAM initialization have not been executed or verified. */
export const sm64StartupFixture = {
  entry: sm64Entry.address,
  cartridgeOffset: 0x1000,
  loadedBytes: 0x100000,
  ramBytes: 0x400000,
  ramFill: 0,
  initialRegisters: 'zero',
  tvType: 'PAL',
  romBase: 0xb0000000,
  eepromBytes: 512,
  consoleReset: 'unverified',
} as const;

export function prepareSm64Startup(cartridge: Uint8Array): N64System {
  const system = new N64System(cartridge, sm64StartupFixture.entry, 512);
  system.memory.ram.bytes.set(
    cartridge.subarray(
      sm64StartupFixture.cartridgeOffset,
      sm64StartupFixture.cartridgeOffset + sm64StartupFixture.loadedBytes,
    ),
    sm64StartupFixture.entry & 0x1fffffff,
  );
  system.memory.write32(0x80000300, 0); // PAL television type.
  system.memory.write32(0x80000308, sm64StartupFixture.romBase);
  system.memory.write32(0x80000318, sm64StartupFixture.ramBytes);
  return system;
}
