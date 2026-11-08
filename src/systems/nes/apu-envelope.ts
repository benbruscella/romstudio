/** Quarter-frame volume divider shared by both pulses and the noise channel.
 * Constant volume selects the DAC value; the envelope keeps clocking. */
export class NesEnvelope {
  control = 0;
  restart = false;
  divider = 0;
  decay = 0;

  get volume(): number {
    return this.control & 16 ? this.control & 15 : this.decay;
  }
  clock(): void {
    if (this.restart) {
      this.restart = false;
      this.decay = 15;
      this.divider = this.control & 15;
    } else if (this.divider) {
      this.divider--;
    } else {
      this.divider = this.control & 15;
      if (this.decay) {
        this.decay--;
      } else if (this.control & 32) {
        this.decay = 15;
      }
    }
  }
  snapshot() {
    return {
      control: this.control,
      restart: this.restart,
      divider: this.divider,
      decay: this.decay,
    };
  }
}
