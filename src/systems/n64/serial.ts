import { Vr4300Gap } from '../../runtime/vr4300.js';

/** Functional Joybus/PIF endpoint: one standard controller and optional EEPROM.
 * SI owns the 64-byte transfers; commands are never replaced in game code. */
export class N64Serial {
  readonly eeprom: Uint8Array;
  buttons = 0;
  stickX = 0;
  stickY = 0;
  dram = 0;
  private active: { read: boolean; remaining: number; dram: number } | undefined;
  private pending = false;
  transfers = 0;
  controllerReads = 0;
  onControllerRead: (() => void) | undefined;
  private controllerResponse: number | undefined;

  constructor(
    private readonly ram: Uint8Array,
    private readonly pif: Uint8Array,
    private readonly interrupt: (asserted: boolean) => void,
    eepromBytes: 0 | 512 | 2048 = 0,
  ) {
    this.eeprom = new Uint8Array(eepromBytes).fill(255);
  }

  read(offset: number): number {
    if (offset === 0) {
      return this.dram;
    }
    if (offset === 0x18) {
      return Number(!!this.active) | (this.pending ? 0x1000 : 0);
    }
    throw new Vr4300Gap(
      'si-register',
      0,
      0x04800000 + offset,
      'SI register read is not implemented.',
    );
  }

  write(offset: number, word: number): void {
    if (offset === 0x18) {
      this.pending = false;
      this.interrupt(false);
      return;
    }
    if (this.active) {
      throw new Vr4300Gap('si-busy', 0, 0x04800000 + offset, 'SI already has an active transfer.');
    }
    if (offset === 0) {
      this.dram = word & 0xfffff8;
      return;
    }
    if (offset !== 4 && offset !== 0x10) {
      throw new Vr4300Gap(
        'si-register',
        0,
        0x04800000 + offset,
        'SI register write is not implemented.',
      );
    }
    if (this.dram + 64 > this.ram.length || (word & 0x1fffffff) !== 0x1fc007c0) {
      throw new Vr4300Gap(
        'si-range',
        0,
        word >>> 0,
        'SI needs a complete 64-byte PIF/RDRAM transfer.',
      );
    }
    this.active = { read: offset === 4, remaining: 512, dram: this.dram };
  }

  advance(ticks: number): void {
    const active = this.active;
    if (!active) {
      return;
    }
    active.remaining -= ticks;
    if (active.remaining > 0) {
      return;
    }

    if (active.read) {
      if (this.controllerResponse !== undefined) {
        // libultra caches the packet layout and performs read-only SI DMAs
        // on later polls. Each read still samples the connected controller.
        this.controllerReads++;
        this.onControllerRead?.();
        this.replyController(this.controllerResponse);
      }
      this.ram.set(this.pif, active.dram);
    } else {
      this.controllerResponse = undefined;
      this.pif.set(this.ram.subarray(active.dram, active.dram + 64));
      if ((this.pif[63]! & 1) !== 0) {
        this.commands();
      }
    }
    this.active = undefined;
    this.transfers++;
    this.pending = true;
    this.interrupt(true);
  }

  private replyController(response: number): void {
    this.pif.set(
      [(this.buttons >>> 8) & 255, this.buttons & 255, this.stickX & 255, this.stickY & 255],
      response,
    );
  }

  private commands(): void {
    let position = 0,
      channel = 0;
    while (position < 63) {
      const send = this.pif[position]!;
      if (send === 0xfe) {
        break;
      }
      if (send === 0xff) {
        position++;
        continue;
      }
      if (send === 0) {
        position++;
        channel++;
        continue;
      }
      const receive = this.pif[position + 1]! & 63;
      const request = position + 2,
        response = request + (send & 63);
      if ((send & 0xc0) !== 0 || response + receive > 63) {
        throw new Vr4300Gap('pif-command', 0, position, 'Unsupported or truncated Joybus command.');
      }
      const command = this.pif[request]!;
      if (channel === 0 && (command === 0 || command === 0xff) && send === 1 && receive === 3) {
        this.pif.set([5, 0, 2], response);
      } else if (channel === 0 && command === 1 && send === 1 && receive === 4) {
        this.controllerResponse = response;
        this.replyController(response);
      } else if (
        channel === 4 &&
        this.eeprom.length &&
        (command === 0 || command === 0xff) &&
        send === 1 &&
        receive === 3
      ) {
        this.pif.set([0, this.eeprom.length === 512 ? 0x80 : 0xc0, 0], response);
      } else if (
        channel === 4 &&
        this.eeprom.length &&
        command === 4 &&
        send === 2 &&
        receive === 8
      ) {
        const block = this.pif[request + 1]! * 8;
        if (block + 8 > this.eeprom.length) {
          throw new Vr4300Gap(
            'eeprom-range',
            0,
            block,
            'EEPROM read exceeds the installed device.',
          );
        }
        this.pif.set(this.eeprom.subarray(block, block + 8), response);
      } else if (
        channel === 4 &&
        this.eeprom.length &&
        command === 5 &&
        send === 10 &&
        receive === 1
      ) {
        const block = this.pif[request + 1]! * 8;
        if (block + 8 > this.eeprom.length) {
          throw new Vr4300Gap(
            'eeprom-range',
            0,
            block,
            'EEPROM write exceeds the installed device.',
          );
        }
        this.eeprom.set(this.pif.subarray(request + 2, request + 10), block);
        this.pif[response] = 0;
      } else if (channel === 0 || (channel === 4 && this.eeprom.length)) {
        throw new Vr4300Gap(
          'joybus-command',
          0,
          command,
          'This connected Joybus command is not implemented.',
        );
      } else {
        this.pif[position + 1] = this.pif[position + 1]! | 0x80; // No device response.
      }
      position = response + receive;
      channel++;
    }
    this.pif[63] = 0;
  }

  snapshot() {
    return {
      eeprom: [...this.eeprom],
      buttons: this.buttons,
      stickX: this.stickX,
      stickY: this.stickY,
      dram: this.dram,
      active: this.active ? { ...this.active } : null,
      pending: this.pending,
      transfers: this.transfers,
      controllerReads: this.controllerReads,
      controllerResponse: this.controllerResponse ?? null,
    };
  }
  ticksUntilEvent(): number {
    return this.active?.remaining ?? Infinity;
  }
  restore(state: ReturnType<N64Serial['snapshot']>): void {
    if (state.eeprom.length !== this.eeprom.length) {
      throw new Error('EEPROM checkpoint does not match the installed device.');
    }
    this.eeprom.set(state.eeprom);
    this.buttons = state.buttons;
    this.stickX = state.stickX;
    this.stickY = state.stickY;
    this.dram = state.dram;
    this.active = state.active ? { ...state.active } : undefined;
    this.pending = state.pending;
    this.transfers = state.transfers;
    this.controllerReads = state.controllerReads;
    this.controllerResponse = state.controllerResponse ?? undefined;
  }
}
