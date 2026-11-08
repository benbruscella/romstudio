/** Register arrays use the host's typed-array layout, independently of the
 * N64's big-endian bus. Both views alias the same bytes; no cache can go stale
 * after a 64-bit write, checkpoint restore or direct register inspection. */
export const lowRegisterWord = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0 : 1;
export const highRegisterWord = 1 - lowRegisterWord;

export function registerWords(registers: BigInt64Array | BigUint64Array): Uint32Array {
  return new Uint32Array(registers.buffer, registers.byteOffset, registers.length * 2);
}
