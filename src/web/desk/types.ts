/** ROM Desk contracts shared by the C64/NES shell and the N64 worker. Every
 * value is structured-clone safe, so the N64 machine can answer from its
 * worker. See docs/DESK.md. */
export interface DeskValue {
  name: string;
  value: string;
  title?: string;
}
export interface DeskProcessorState {
  /** `cpu`, or `rsp` on the N64. */
  id: string;
  label: string;
  pc: number;
  /** Live instruction bytes read side-effect-free at the PC; empty if the
   * PC is not readable memory. */
  bytes: number[];
  /** Key of the generated function: `at_<pc>_<opcode>`. */
  opcode: number | undefined;
  identity: string;
  registers: DeskValue[];
  flags?: { name: string; set: boolean; title: string }[];
  /** For example "halted" when the RSP is not running. */
  note?: string;
  /** Package-relative folder holding observed-source.json for this processor. */
  sourceDirectory: string;
}
export interface DeskState {
  processors: DeskProcessorState[];
  counters: DeskValue[];
  frame: number;
  tier: string;
  /** What the last step or run did, in words. */
  last?: string;
  gap?: string;
}
export type DeskStepKind = 'instruction' | 'frame' | 'cpu' | 'rsp' | 'tick';
export interface DeskMemorySpace {
  id: string;
  label: string;
  /** Address shown first. */
  start: number;
  size: number;
}
export interface DeskRun {
  breakpoints: number[];
  /** Frames to run before pausing again if no breakpoint is reached. */
  frames: number;
}
/** One system adapter. C64/NES answer synchronously from the page; the N64
 * forwards each call to its machine worker. */
export interface DeskTarget {
  readonly system: 'c64' | 'nes' | 'n64';
  readonly steps: readonly { kind: DeskStepKind; label: string; title: string }[];
  readonly memory: readonly DeskMemorySpace[];
  /** Pause at the next safe boundary and return the paused state. */
  open(): Promise<DeskState>;
  /** Leave the Desk and resume ordinary play. */
  close(): Promise<void>;
  state(): Promise<DeskState>;
  step(kind: DeskStepKind): Promise<DeskState>;
  run(request: DeskRun): Promise<DeskState & { stopped: 'breakpoint' | 'frames' | 'gap' }>;
  /** Ask a running `run` to pause after its current frame. */
  interrupt(): void;
  read(space: string, address: number, length: number): Promise<(number | undefined)[]>;
  restart(): Promise<DeskState>;
}
export interface DeskSymbol {
  start: number;
  end: number;
  name: string;
  detail: string;
  evidence: string;
  bank?: string;
  epoch?: string;
}
