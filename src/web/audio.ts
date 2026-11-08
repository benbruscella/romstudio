/** Browser output only. Sound comes from the system's generated PCM, never
 * replacement tunes or UI-triggered game effects. No audio before a gesture. */
export class BrowserAudio {
  private context: AudioContext | undefined;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private next = 0;
  get active(): boolean {
    return this.context?.state === 'running';
  }
  get sampleRate(): number {
    return this.context?.sampleRate ?? 44100;
  }
  async resume(): Promise<void> {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    await this.context.resume();
  }
  stop(): void {
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.next = 0;
  }
  queue(samples: Float32Array, channels: 1 | 2 = 1): void {
    const context = this.context;
    if (!context || context.state !== 'running' || !samples.length) {
      return;
    }
    const now = context.currentTime;
    if (this.next < now || this.next > now + 0.25) {
      this.stop();
      this.next = now + 0.04;
    }
    const frames = Math.floor(samples.length / channels);
    const buffer = context.createBuffer(channels, frames, context.sampleRate);
    for (let channel = 0; channel < channels; channel++) {
      const values = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        values[frame] = samples[frame * channels + channel]!;
      }
      buffer.copyToChannel(values, channel);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };
    source.start(this.next);
    this.next += frames / context.sampleRate;
  }
}
