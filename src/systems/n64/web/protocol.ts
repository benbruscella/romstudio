import type { N64Input } from '../input.js';
import type { N64PlayerGap } from '../player.js';
import type { N64Display } from '../display.js';
import type { RdpFrame } from '../rdp-stream.js';

/** Play uses the play tier; `reference` runs every original RSP task, for
 * comparison. See docs/ARCHITECTURE.md#execution-tiers. */
export type N64ExecutionTier = 'play' | 'reference';

export type N64WorkerRequest =
  | { type: 'load'; base: string; tier: N64ExecutionTier }
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
      highLevelTasks: number;
      gap?: N64PlayerGap;
    }
  | { type: 'error'; detail: string };
/** Play tier: the machine worker streams each graphics task to a parallel
 * RDP worker, which owns the framebuffer and returns finished frames. */
export type N64RdpRequest =
  | {
      type: 'init';
      generation: number;
      ram: Uint8Array;
      display: ReturnType<N64Display['snapshot']>;
      height: number;
    }
  | { type: 'frame'; generation: number; frame: RdpFrame };
export type N64RdpReply =
  | { type: 'drawn'; generation: number; pixels?: Uint8Array }
  | { type: 'error'; generation: number; detail: string };
export interface N64WebTitle {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  actions: readonly { code: string; label: string }[];
  help: readonly string[];
}
