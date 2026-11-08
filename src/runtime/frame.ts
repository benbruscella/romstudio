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
 * boundary services and cycle count; this layer knows no registers or games. */
export class FrameClock {
  constructor(private deadline: number) {}
  advance<Result>(
    host: ExecutionHost<Result>,
    cycles: number,
    result?: () => Result | undefined,
  ): void {
    if (host.outcome || host.gap) {
      return;
    }
    this.deadline += cycles;
    let operations = 0;
    try {
      while (host.machine.cycles < this.deadline) {
        const outcome = result?.();
        if (outcome) {
          host.outcome = outcome;
          break;
        }
        if (++operations > 20000) {
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
  }
}
