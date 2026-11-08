# NMOS decimal arithmetic

Nebulus decrements its packed decimal timer at `$B699` using decimal SBC. [The shared CPU](../src/runtime/mos6502.ts) implements decimal ADC/SBC for C64 and other NMOS targets. NES configures the same backend to retain the D flag while performing binary arithmetic. Timing remains the NMOS instruction timing; no CMOS extra cycle is added.

ADC corrects the low digit before determining N/V, sets Z from the binary sum, then corrects the high digit and determines carry. SBC keeps the binary N/V/Z/C flags and corrects the stored decimal result. These flags can differ from the final accumulator: decimal `$99 + $01` yields `$00` with Z clear.

The behavioral reference is the original hardware investigation [NMOS 6510 Unintended Opcodes — No More Secrets, decimal mode chapter](https://zxe.io/depot/documents/technical/NMOS%206510%20Unintended%20Opcodes%20-%20No%20More%20Secrets%20v0.96%20%282021-12-24%29%28groepaz%29%28en%29%5B%21%5D.pdf). The implementation is ROM Studio's own code. [Tests](../src/runtime/mos6502-decimal.test.ts) independently compare every valid BCD operand pair and incoming carry with ordinary integer arithmetic, retain the exhaustive binary tests, and check NMOS flag examples and selected invalid-digit cases. This is instruction-semantic evidence, not full bus-cycle or hardware parity.

Decimal semantics stay in the shared CPU after title modules move to `src/games/`. The optional bus hook adds C64 clocks and read-ready waits around those same operations. Recovery now shares lowered operations between operand changes while retaining separate exact-byte epochs and opcode guards; this changes allocation, not decimal behavior. See [the shared runtime](ARCHITECTURE.md) and [verification notes](BUILD.md).
