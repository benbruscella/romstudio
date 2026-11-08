import { AdapterRegistry } from '../contracts.js';
import { c64 } from './c64.js';
/** Node-side discovery. Browser packages include only their chosen machine. */
export const systems = new AdapterRegistry();
systems.register(c64);

import { nes } from './nes.js';
systems.register(nes);
