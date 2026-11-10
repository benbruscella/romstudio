import { rspReciprocal, rspReciprocalSquareRoot } from './rsp-reciprocal.js';

export type RspMultiplyKind =
  'fractional' | 'unsigned-high' | 'signed-unsigned' | 'unsigned-signed' | 'signed-high';

/** RSP vectors use eight logical 16-bit lanes. Byte element zero is the high
 * byte of lane zero, regardless of the JavaScript host's byte order. */
export class RspVector {
  readonly registers = new Uint16Array(32 * 8);
  // Architectural signed 48-bit integers. A JS number represents every one
  // exactly (53 integer bits); products and one addition stay below 49 bits.
  // Wrap explicitly at bit 48, rather than allocating BigInts per lane.
  readonly accumulator = new Float64Array(8);
  private readonly selectedLanes = new Uint16Array(8);
  carry = 0;
  compare = 0;
  extension = 0;
  dividerInput = 0;
  dividerOutput = 0;
  dividerPending = false;

  constructor(private readonly unsupported: (detail: string) => never) {}

  lane(register: number, lane: number): number {
    return this.registers[register * 8 + lane]!;
  }
  setLane(register: number, lane: number, value: number): void {
    this.registers[register * 8 + lane] = value & 65535;
  }
  byte(register: number, element: number): number {
    const value = this.lane(register, element >>> 1);
    return element & 1 ? value & 255 : value >>> 8;
  }
  setByte(register: number, element: number, value: number): void {
    const old = this.lane(register, element >>> 1);
    this.setLane(
      register,
      element >>> 1,
      element & 1 ? (old & 0xff00) | (value & 255) : (old & 255) | ((value & 255) << 8),
    );
  }
  moveFrom(register: number, element: number): number {
    return (
      (((this.byte(register, element) << 8) | this.byte(register, (element + 1) & 15)) << 16) >> 16
    );
  }
  moveTo(register: number, element: number, value: number): void {
    this.setByte(register, element, value >>> 8);
    if (element < 15) {
      this.setByte(register, element + 1, value);
    }
  }
  readControl(index: number): number {
    if (index > 2) {
      return this.unsupported(`Vector control register ${index} is not implemented.`);
    }
    const word = index === 0 ? this.carry : index === 1 ? this.compare : this.extension;
    return index === 2 ? word : (word << 16) >> 16;
  }
  writeControl(index: number, value: number): void {
    if (index === 0) {
      this.carry = value & 65535;
    } else if (index === 1) {
      this.compare = value & 65535;
    } else if (index === 2) {
      this.extension = value & 255;
    } else {
      this.unsupported(`Vector control register ${index} is not implemented.`);
    }
  }
  private selected(element: number, lane: number): number {
    if (element < 2) {
      return lane;
    }
    if (element < 4) {
      return (lane & 6) | (element & 1);
    }
    if (element < 8) {
      return (lane & 4) | (element & 3);
    }
    return element & 7;
  }
  private low(lane: number, value: number): void {
    this.accumulator[lane] = Math.floor(this.accumulator[lane]! / 65536) * 65536 + (value & 65535);
  }
  private signed(value: number): number {
    return Math.max(-32768, Math.min(32767, value));
  }
  private fractional(value: number): number {
    const upper = Math.floor(value / 65536);
    return upper < -32768 ? 0 : upper > 32767 ? 65535 : value & 65535;
  }

  /** The compiler chooses the original multiply's signedness and result
   * slice once. Keep execute() as the general operation/reference path.
   * Every product, sum and signed-48-bit wrap stays exact in binary64. */
  multiply(
    kind: RspMultiplyKind,
    accumulate: boolean,
    destination: number,
    left: number,
    right: number,
    element: number,
  ): void {
    const registers = this.registers,
      destinationBase = destination * 8,
      leftBase = left * 8,
      rightBase = right * 8,
      broadcast = element >= 8,
      broadcastValue = broadcast ? registers[rightBase + (element & 7)]! : 0,
      snapshotRight = !broadcast && destination === right && element >= 2;
    if (snapshotRight) {
      for (let lane = 0; lane < 8; lane++) {
        this.selectedLanes[lane] = registers[rightBase + this.selected(element, lane)]!;
      }
    }
    const lowResult = kind === 'unsigned-high' || kind === 'unsigned-signed',
      initial = kind === 'fractional' ? 32768 : 0;
    for (let lane = 0; lane < 8; lane++) {
      const a = registers[leftBase + lane]!,
        b = broadcast
          ? broadcastValue
          : snapshotRight
            ? this.selectedLanes[lane]!
            : registers[rightBase + this.selected(element, lane)]!,
        signedA = (a << 16) >> 16,
        signedB = (b << 16) >> 16;
      const product =
        kind === 'fractional'
          ? signedA * signedB * 2
          : kind === 'unsigned-high'
            ? Math.floor((a * b) / 65536)
            : kind === 'signed-unsigned'
              ? signedA * b
              : kind === 'unsigned-signed'
                ? a * signedB
                : signedA * signedB * 65536;
      let value = (accumulate ? this.accumulator[lane]! : initial) + product;
      if (value >= 2 ** 47) {
        value -= 2 ** 48;
      } else if (value < -(2 ** 47)) {
        value += 2 ** 48;
      }
      this.accumulator[lane] = value;
      const upper = Math.floor(value / 65536);
      registers[destinationBase + lane] = lowResult
        ? upper < -32768
          ? 0
          : upper > 32767
            ? 65535
            : value & 65535
        : upper < -32768
          ? -32768
          : upper > 32767
            ? 32767
            : upper;
    }
  }

  execute(
    operation: string,
    destination: number,
    left: number,
    right: number,
    element: number,
  ): void {
    if (operation === 'VNOP') {
      return;
    }
    if (['VMOV', 'VRCP', 'VRCPL', 'VRCPH', 'VRSQ', 'VRSQL', 'VRSQH'].includes(operation)) {
      const destinationLane = left & 7;
      // VMOV uses the vector selector; divide instructions index VT directly.
      const input = this.lane(
        right,
        operation === 'VMOV' ? this.selected(element, destinationLane) : element & 7,
      );
      for (let lane = 0; lane < 8; lane++) {
        this.low(lane, this.lane(right, this.selected(element, lane)));
      }
      if (operation === 'VMOV') {
        this.setLane(destination, destinationLane, input);
      } else if (operation === 'VRCPH' || operation === 'VRSQH') {
        this.setLane(destination, destinationLane, this.dividerOutput >>> 16);
        this.dividerInput = input;
        this.dividerPending = true;
      } else {
        const argument =
          (operation === 'VRCPL' || operation === 'VRSQL') && this.dividerPending
            ? (this.dividerInput << 16) | input
            : (input << 16) >> 16;
        this.dividerOutput = operation.startsWith('VRSQ')
          ? rspReciprocalSquareRoot(argument)
          : rspReciprocal(argument);
        this.dividerPending = false;
        this.setLane(destination, destinationLane, this.dividerOutput);
      }
      return;
    }
    // VS and unselected VT are lane-local: reading a lane before writing that
    // same lane is safe even when VD aliases them. Only a selected/broadcast
    // VT that aliases VD can read a lane overwritten by an earlier iteration.
    const snapshotRight = destination === right && element >= 2,
      other = this.selectedLanes,
      leftBase = left * 8,
      rightBase = right * 8;
    if (snapshotRight) {
      for (let lane = 0; lane < 8; lane++) {
        other[lane] = this.lane(right, this.selected(element, lane));
      }
    }
    const carry = this.carry,
      compare = this.compare,
      extension = this.extension;
    const multiply = /^V(?:MULF|MACF|MUD[LMNH]|MAD[LMNH])$/.test(operation),
      family = operation.slice(-1),
      accumulate = operation.startsWith('VMAC') || operation.startsWith('VMAD'),
      addition = ['VADD', 'VSUB', 'VABS', 'VADDC', 'VSUBC'].includes(operation),
      logical = ['VAND', 'VNAND', 'VOR', 'VNOR', 'VXOR', 'VNXOR'].includes(operation),
      clipping = ['VCH', 'VCL', 'VCR'].includes(operation),
      comparison = ['VLT', 'VEQ', 'VNE', 'VGE', 'VMRG'].includes(operation);
    let nextCarry = 0,
      nextCompare = 0,
      nextExtension = 0;
    for (let lane = 0; lane < 8; lane++) {
      const a = this.registers[leftBase + lane]!,
        b = snapshotRight
          ? other[lane]!
          : this.registers[rightBase + this.selected(element, lane)]!,
        sa = (a << 16) >> 16,
        sb = (b << 16) >> 16;
      let result: number;
      if (multiply) {
        // All integer products and sums here are exact in binary64. Even a
        // shifted product plus the previous accumulator needs fewer than 49
        // bits. One correction restores the signed 48-bit hardware range.
        let product: number;
        if (family === 'F') {
          product = sa * sb * 2;
        } else if (family === 'L') {
          product = Math.floor((a * b) / 65536);
        } else if (family === 'M') {
          product = sa * b;
        } else if (family === 'N') {
          product = a * sb;
        } else {
          product = sa * sb * 65536;
        }
        let value =
          (accumulate ? this.accumulator[lane]! : operation === 'VMULF' ? 32768 : 0) + product;
        if (value >= 2 ** 47) {
          value -= 2 ** 48;
        } else if (value < -(2 ** 47)) {
          value += 2 ** 48;
        }
        this.accumulator[lane] = value;
        result =
          family === 'L' || family === 'N'
            ? this.fractional(value)
            : this.signed(Math.floor(value / 65536));
      } else if (operation === 'VSAR') {
        result =
          element >= 8 && element <= 10
            ? Math.floor(this.accumulator[lane]! / 2 ** ((10 - element) * 16)) & 65535
            : 0;
      } else if (addition) {
        const incoming = (carry >>> lane) & 1;
        const value =
          operation === 'VADD'
            ? sa + sb + incoming
            : operation === 'VSUB'
              ? sa - sb - incoming
              : operation === 'VABS'
                ? sa < 0
                  ? -sb
                  : sa === 0
                    ? 0
                    : sb
                : operation === 'VADDC'
                  ? a + b
                  : a - b;
        this.low(lane, value);
        result =
          operation === 'VADDC' || operation === 'VSUBC'
            ? value
            : Math.max(-32768, Math.min(32767, value));
        if (operation === 'VADDC' && value > 65535) {
          nextCarry |= 1 << lane;
        }
        if (operation === 'VSUBC') {
          if (value < 0) {
            nextCarry |= 1 << lane;
          }
          if (value !== 0) {
            nextCarry |= 1 << (lane + 8);
          }
        }
      } else if (logical) {
        result =
          operation === 'VAND'
            ? a & b
            : operation === 'VNAND'
              ? ~(a & b)
              : operation === 'VOR'
                ? a | b
                : operation === 'VNOR'
                  ? ~(a | b)
                  : operation === 'VXOR'
                    ? a ^ b
                    : ~(a ^ b);
        this.low(lane, result);
      } else if (clipping) {
        // Clipping records two comparisons per lane: VS <= -VT in VCC_LO
        // and VS >= VT in VCC_HI. VCH retains the sign and boundary cases
        // so VCL can finish a 32-bit comparison using unsigned low halves.
        let sign: boolean, le: boolean, ge: boolean;
        if (operation === 'VCL') {
          sign = ((carry >>> lane) & 1) !== 0;
          le = ((compare >>> lane) & 1) !== 0;
          ge = ((compare >>> (lane + 8)) & 1) !== 0;
          if (((carry >>> (lane + 8)) & 1) === 0) {
            if (sign) {
              const sum = a + b;
              le = extension & (1 << lane) ? sum <= 65536 : sum === 0;
            } else {
              ge = a >= b;
            }
          }
          result = sign ? (le ? -b : a) : ge ? b : a;
        } else {
          sign = sa < 0 !== sb < 0;
          const sum = sa + sb;
          le = sign ? sum + (operation === 'VCR' ? 1 : 0) <= 0 : sb < 0;
          ge = sign ? sb < 0 : sa >= sb;
          result = sign ? (le ? (operation === 'VCR' ? ~b : -b) : a) : ge ? b : a;
          if (operation === 'VCH') {
            const boundary = sign && sum === -1;
            if (sign) {
              nextCarry |= 1 << lane;
            }
            // The -VT-1 boundary sets VCE and clears VCO_HI, allowing VCL
            // to resolve it. The SGI v1.1 pseudocode omits this exception.
            if (!boundary && (sign ? sum !== 0 : a !== b)) {
              nextCarry |= 1 << (lane + 8);
            }
            if (boundary) {
              nextExtension |= 1 << lane;
            }
          }
        }
        if (le) {
          nextCompare |= 1 << lane;
        }
        if (ge) {
          nextCompare |= 1 << (lane + 8);
        }
        this.low(lane, result);
      } else if (comparison) {
        const low = ((carry >>> lane) & 1) !== 0,
          high = ((carry >>> (lane + 8)) & 1) !== 0;
        const select =
          operation === 'VLT'
            ? sa < sb || (sa === sb && low && high)
            : operation === 'VEQ'
              ? sa === sb && !high
              : operation === 'VNE'
                ? sa !== sb || high
                : operation === 'VGE'
                  ? sa > sb || (sa === sb && !(low && high))
                  : ((compare >>> lane) & 1) !== 0;
        if (select) {
          nextCompare |= 1 << lane;
        }
        result = select ? a : b;
        this.low(lane, result);
      } else {
        return this.unsupported(`RSP vector operation ${operation} is not implemented.`);
      }
      this.setLane(destination, lane, result);
    }
    if (
      [
        'VADD',
        'VSUB',
        'VABS',
        'VADDC',
        'VSUBC',
        'VLT',
        'VEQ',
        'VNE',
        'VGE',
        'VMRG',
        'VCH',
        'VCL',
        'VCR',
      ].includes(operation)
    ) {
      this.carry = nextCarry;
    }
    if (['VLT', 'VEQ', 'VNE', 'VGE', 'VCH', 'VCL', 'VCR'].includes(operation)) {
      this.compare = nextCompare;
      this.extension = nextExtension;
    }
  }

  snapshot() {
    return {
      registers: [...this.registers],
      accumulator: Array.from(this.accumulator, (value) =>
        (value < 0 ? value + 2 ** 48 : value).toString(16).padStart(12, '0'),
      ),
      carry: this.carry,
      compare: this.compare,
      extension: this.extension,
      dividerInput: this.dividerInput,
      dividerOutput: this.dividerOutput,
      dividerPending: this.dividerPending,
    };
  }

  restore(state: ReturnType<RspVector['snapshot']>): void {
    this.registers.set(state.registers);
    this.accumulator.set(
      state.accumulator.map((value) => {
        const bits = parseInt(value, 16);
        return bits >= 2 ** 47 ? bits - 2 ** 48 : bits;
      }),
    );
    this.carry = state.carry;
    this.compare = state.compare;
    this.extension = state.extension;
    this.dividerInput = state.dividerInput;
    this.dividerOutput = state.dividerOutput;
    this.dividerPending = state.dividerPending;
  }
}
