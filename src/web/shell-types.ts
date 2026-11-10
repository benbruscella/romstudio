import type { Machine } from '../runtime/mos6502.js';
import type { BrowserControls } from '../runtime/controls.js';
import type { Mos6502DeskHost } from './desk/mos6502.js';
export interface ShellResult {
  won: boolean;
  title: string;
  detail: string;
}
export interface ShellPlayer {
  readonly controlFrames: number;
  readonly gap: { kind: string; address: number; pc: number; detail: string } | undefined;
  readonly result: ShellResult | undefined;
  readonly display: { pixels: Uint8Array };
  readonly startPrompt?: string | undefined;
  /** The underlying player, for ROM Desk. */
  readonly desk?: Mos6502DeskHost;
  advanceFrame(): void;
  enableAudio(sampleRate: number): void;
  takeAudio(): Float32Array;
  stats(): Record<string, string | number>;
  selected(action: string): boolean;
}
export interface TitleAction {
  id: string;
  label: string;
  hint?: string;
  code: string;
  offsets: readonly number[];
  quiet?: boolean;
  toggle?: boolean;
  counter?: { stat: string; id: string };
}
export interface BrowserTitle {
  id: string;
  title: string;
  eyebrow: string;
  edition: string;
  goal: string;
  heading: string;
  description: string;
  display: { width: number; height: number; frameSeconds: number };
  minimumInputPolls?: number;
  audioSupported: boolean;
  audioDescription: string;
  stats: readonly { id: string; label: string }[];
  actions: readonly TitleAction[];
  help: readonly string[];
  example: string;
  learn: readonly { text: string; href: string }[];
  gamepadShortcut?: string;
  create(
    checkpoint: unknown,
    step: (machine: Machine) => void,
    input: (frame: number) => BrowserControls,
    recording?: unknown,
  ): ShellPlayer;
}
