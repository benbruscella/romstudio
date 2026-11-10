/** EU revision-0 values recovered from ROM+$1000 at CPU $80241800. These
 * explanatory names are ours; the matching decompilation independently names
 * the corresponding entry, BSS and idle-thread stack. */
export const sm64Entry = {
  address: 0x80241800,
  romOffset: 0x1000,
  words: 14,
  bssStart: 0x80307e50,
  bssBytes: 0x2f0c0,
  main: 0x80242e80,
  stack: 0x801fba00,
};

/** Named interpretation used for comparison, not substituted into the game.
 * The original loop clears eight bytes per iteration. Its delay-slot ADDI
 * advances $t0 even when the final BNE is not taken. JR's delay slot completes
 * the stack address before the main function begins. */
export function interpretSm64Entry(ram: Uint8Array, registers: BigInt64Array) {
  const result = ram.slice(),
    nextRegisters = registers.slice();
  const start = sm64Entry.bssStart & 0x1fffffff;
  result.fill(0, start, start + sm64Entry.bssBytes);
  nextRegisters[0] = 0n;
  nextRegisters[8] = BigInt.asIntN(32, BigInt(sm64Entry.bssStart + sm64Entry.bssBytes));
  nextRegisters[9] = 0n;
  nextRegisters[10] = BigInt.asIntN(32, BigInt(sm64Entry.main));
  nextRegisters[29] = BigInt.asIntN(32, BigInt(sm64Entry.stack));
  return {
    ram: result,
    registers: nextRegisters,
    pc: sm64Entry.main,
    instructions: 4 + 5 * (sm64Entry.bssBytes / 8) + 5,
  };
}
