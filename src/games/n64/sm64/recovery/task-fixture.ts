import { N64System } from '../../../../systems/n64/system.js';

/** Retain exact processor-task inputs while explicitly pausing the CPU.
 * Other devices use fresh defaults and a fresh functional clock. */
export function cloneGraphicsFixture(input: N64System): N64System {
  const system = new N64System(new Uint8Array(0), 0);
  system.memory.ram.bytes.set(input.memory.ram.bytes);
  system.memory.signal.memory.set(input.memory.signal.memory);
  system.memory.signal.restore(input.memory.signal.snapshot());
  system.rsp.restore(input.rsp.snapshot());
  system.memory.display.restore(input.memory.display.snapshot());
  return system;
}
