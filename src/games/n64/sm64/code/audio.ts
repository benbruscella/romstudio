/** Named interpretation of the EU audio microcode's MIXER command. The
 * original vector code processes sixteen signed PCM samples per loop. This
 * explanation is checked against that code; it is not a runtime shortcut. */
export function mixAudioSamples(
  input: Int16Array,
  destination: Int16Array,
  signedGain: number,
): Int16Array {
  if (
    input.length !== destination.length ||
    !Number.isInteger(signedGain) ||
    signedGain < -32768 ||
    signedGain > 32767
  ) {
    throw new RangeError('MIXER requires equal sample counts and a signed 16-bit gain.');
  }
  return Int16Array.from(destination, (sample, index) => {
    // VMULF adds the rounding half-unit; VMACF adds into the same accumulator.
    // Keep that fraction until the final signed saturation. All values here
    // fit exactly in JavaScript's integer range, including negative products.
    const accumulated = sample * 32767 * 2 + 32768 + input[index]! * signedGain * 2;
    const mixed = Math.floor(accumulated / 65536);
    return Math.max(-32768, Math.min(32767, mixed));
  });
}
