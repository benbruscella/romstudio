import { N64Display } from '../display.js';
import { renderN64ColorImage } from '../render.js';
import { replayRdpFrame } from '../rdp-stream.js';
import type { N64RdpReply, N64RdpRequest } from './protocol.js';

/** Play tier: draws streamed graphics tasks with the same software RDP, on
 * a private RDRAM mirror, in parallel with the machine worker. */
const port = globalThis as unknown as {
  onmessage: (event: MessageEvent<N64RdpRequest>) => void;
  postMessage(message: N64RdpReply, transfer?: Transferable[]): void;
};
let display: N64Display | undefined,
  ram: Uint8Array = new Uint8Array(0),
  height = 0,
  generation = -1,
  finished = false;

port.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      generation = data.generation;
      ram = data.ram;
      height = data.height;
      display = new N64Display(
        ram,
        () => 0,
        () => {
          finished = true;
        },
      );
      display.restore(data.display);
      return;
    }
    if (data.generation !== generation || !display) {
      return;
    }
    finished = false;
    replayRdpFrame(data.frame, display, ram);
    display.commands.length = 0;
    display.fills.length = 0;
    display.triangles.length = 0;
    display.texture.loads.length = 0;
    if (finished) {
      const pixels = renderN64ColorImage(ram, display.colorImage, height);
      port.postMessage({ type: 'drawn', generation, pixels }, [pixels.buffer as ArrayBuffer]);
    } else {
      port.postMessage({ type: 'drawn', generation });
    }
  } catch (error) {
    port.postMessage({ type: 'error', generation, detail: (error as Error).message });
  }
};
