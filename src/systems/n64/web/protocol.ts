import type { N64Input } from '../input.js';
import type { N64PlayerGap } from '../player.js';

export type N64WorkerRequest =
  | { type: 'load'; base: string }
  | { type: 'input'; input: N64Input }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'audio'; sampleRate: number };
export type N64WorkerReply =
  | { type: 'ready'; pixels: Uint8Array }
  | {
      type: 'update';
      pixels?: Uint8Array;
      audio: Float32Array;
      polls: number;
      ticks: number;
      fullSyncs: number;
      fps: number;
      rspSpanInstructions: number;
      gap?: N64PlayerGap;
    }
  | { type: 'error'; detail: string };
export interface N64WebTitle {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  actions: readonly { code: string; label: string }[];
  help: readonly string[];
}
