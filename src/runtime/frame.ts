import { ExecutionGap, type Machine } from './mos6502.js';
export interface RecoveryGap {
  kind: string;
  address: number;
  pc: number;
  detail: string;
}
interface ExecutionHost<Result> {
  machine: Machine;
  step(machine: Machine): void;
  boundary(): boolean;
  outcome: Result | undefined;
  gap: RecoveryGap | undefined;
}
/** Shared pacing of already-translated instructions. Hardware supplies the
 * boundary services and cycle count; this layer knows no registers or games.
 *
 * ROM Desk may stop inside a frame (`stop` is asked before every boundary
 * service or instruction). The frame then stays open, with its deadline and
 * service budget, and the next call continues it. Stepping therefore runs
 * exactly the operations an uninterrupted frame would. */
export class FrameClock {
  /** Completed frames. */
  frames = 0;
  private open = false;
  private operations = 0;
  constructor(private deadline: number) {}
  /** Returns true when the frame completed (or execution already ended),
   * false when `stop` paused it. */
  advance<Result>(
    host: ExecutionHost<Result>,
    cycles: number,
    result?: () => Result | undefined,
    stop?: (machine: Machine) => boolean,
  ): boolean {
    if (host.outcome || host.gap) {
      return true;
    }
    if (!this.open) {
      this.deadline += cycles;
      this.operations = 0;
      this.open = true;
    }
    try {
      while (host.machine.cycles < this.deadline) {
        const outcome = result?.();
        if (outcome) {
          host.outcome = outcome;
          break;
        }
        if (stop?.(host.machine)) {
          return false;
        }
        if (++this.operations > 20000) {
          host.machine.gap('frame-budget', 'Frame instruction/service budget exhausted.');
        }
        if (!host.boundary()) {
          host.step(host.machine);
        }
      }
    } catch (error) {
      if (!(error instanceof ExecutionGap)) {
        throw error;
      }
      host.gap = {
        kind: error.kind,
        address: error.address,
        pc: host.machine.pc,
        detail: error.message,
      };
    }
    this.open = false;
    this.frames++;
    return true;
  }
}
