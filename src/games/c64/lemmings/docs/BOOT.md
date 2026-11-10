# Reading Lemmings through its boot code

This is a growing guide to the code recovered from the supplied C64 release. The first chapter follows startup to the main menu; [the next chapter](LEVELS.md) follows the first two level loads, terrain probes and first lemming spawns. The original author's symbols and source files are unavailable; names such as `relocateLoaderPayload` describe our interpretation, backed by addresses, guarded bytes and tests.

Start with [LemmingsBoot](../code/startup.ts), then [the screen editor service](../../../../systems/c64/kernal.ts) and [the display decoder](../../../../systems/c64/render.ts). The CPU lifter is recovery machinery; named routines are where we explain the behavior we understand.

Run the chapter:

```sh
npm ci
npm test
npm run cli -- boot
```

The command prints an output directory containing `report.json`, `menu.png`, `menu.asm`, RAM and colour snapshots, a known-memory mask and observed instruction variants. Commercial bytes and images stay in ignored local output directories. The verification report distinguishes successful startup checks from hardware and gameplay parity, which remain unverified.

## Follow the changing address space

An address is a place in memory, not a permanent function identity. Different code occupies the same place during startup.

| Address or range                   | Observed behavior                                                                                                  | Where to read it                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `$080C–$0822`                      | Copy 256 bytes from `$4131` to `$0340`, then jump there.                                                           | Generated `bootstrap.asm`; the spec's bootstrap listing       |
| `$0340`                            | Run the relocated unpacker. It also copies a table to `$0723`, overwriting the bootstrap that is no longer needed. | `npm run cli -- recover`; generated `relocated.asm`           |
| `$2300 → $2C16`                    | Enter the release intro, clear the screen and run fades.                                                           | Observed variants and `KernalServices.clearScreen`            |
| `$23B4`, `$23F0`                   | Nested raster interrupt handlers maintain the release intro.                                                       | The IRQ service and observed variants                         |
| `$2CAF`                            | Poll SPACE. The scripted input continues through the original exit branch.                                         | `LemmingsBoot.boundary`                                       |
| `$0405–$041B`                      | Relocate the next payload from `$3901` to `$0801`.                                                                 | `relocateLoaderPayload`                                       |
| `$0801 → $0100`                    | Copy another unpacker into `$00E8–$01E7` and enter it inside the stack page.                                       | Observed variants                                             |
| `$0F2E`                            | Wait for SPACE on each of three documentation pages.                                                               | Scripted input log                                            |
| `$9056` and subsequent Y/N callers | Accept or reject twelve trainers using KERNAL GETIN.                                                               | `answerTrainerPrompt`                                         |
| `$CE58`, `$CE7C`                   | Read compressed block headers and expand the selected disk stream.                                                 | `startCompressedFile`; original observed decoder instructions |
| `$91C4` after the menu loads       | Reach the game's menu input loop.                                                                                  | Generated `menu.asm` and `menu.png`                           |

The first unpacker also executes at `$0405`. The later relocation annotation is enabled only after the release exit has been observed. This is why an address match alone is insufficient. Each translated instruction checks the bytes that produced it; changed bytes cause a new translation. Variant records include their first-observed memory epoch and byte writers. For host system services, writer metadata identifies the most recent real call site; it is coarse provenance rather than a claim about each internal firmware store.

## Why move the code?

The loader needs to overwrite memory that previously held its own packed program. It first moves a small executable routine somewhere safe, runs that routine, and then reuses the old space. The second unpacker goes further and executes inside the stack page.

This release also modifies instruction operands. A store instruction can retain its opcode while its destination changes between iterations. ROM Studio's byte guards cover operands as well as opcodes, so the generated routine for an earlier destination cannot silently execute with the new bytes.

## A readable relocation routine

The original page-copy loop starts with source `$3901`, destination `$0801`, and increments their high bytes until the source high byte wraps to zero. That is 199 pages. Its final source byte wraps to `$0000`, the processor-port direction register.

The named implementation makes the data movement explicit:

```ts
for (let offset = 0; offset < 199 * 256; offset++) {
  const source = (0x3901 + offset) & 65535;
  const destination = 0x0801 + offset;
  // Copy the value and preserve whether that value is known.
}
```

Some copied pages contain unused, uninitialised RAM. The original loop's branches depend on its counters, not on those bytes: `INY` replaces the load's flags before `BNE`. The guarded bulk operation can therefore copy unknown values while retaining their unknown status. Later attempts to use unknown RAM still stop. This transformation avoids pretending that undocumented power-on RAM contains verified zeroes.

## The trainer menu is ordinary input-driven code

Each recovered prompt calls GETIN and compares the result with PETSCII `Y` (`$59`) and `N` (`$4E`). The automation matches that instruction pattern at the return address and supplies `N`. It records the caller and raw screen codes for each choice. GETIN calls outside that pattern receive no automatic answer.

This lets the original code take its normal “no” branches. Startup verification requires twelve distinct callers, twelve `N` replies and the expected menu checkpoint. Custom character sets can give screen codes different meanings, so the log retains raw codes instead of presenting a guessed text transcription.

## A directory entry marked PRG can contain packed data

The normal boot file starts with a little-endian PRG load address. The two-letter files reached by the game loader have a different structure. Their block headers are:

| Offset   | Meaning recovered from the loader        |
| -------- | ---------------------------------------- |
| 0–1      | Compressed byte count, high byte first   |
| 2–3      | Destination end address, high byte first |
| 4        | Initial bit buffer                       |
| 5 onward | Compressed bytes                         |

The first observed request is `ID`, whose header starts `0F 64 6C FF D0`: 3,940 compressed bytes, destination end `$6CFF`, and bit buffer `$D0`. The decoder writes its output backward from the destination end. Its code distinguishes literal bytes from copies of already expanded data.

Files can contain several blocks. `CB` contains a 113-byte block ending at `$60C7`, followed by a 6,520-byte block ending at `$A2B0`. Their two headers and payloads total 6,643 bytes. Assuming one block per directory entry would reject this valid input.

The startup run observes `ID`, `IE`, `PA`, `CA`, `CB` in that order. The report retains the selected disk hash, directory entry, block descriptions and byte counts. Other file groups, including `SA`–`SI`, retain unassigned roles until later traces support an interpretation.

## Keep transport and decompression separate

`receiveDiskByte` supplies bytes from the pinned disk file at the original receiver boundary `$CF4D`. The original header reader and `$CE7C` decompressor continue executing as translated instructions. This recovers the game's data handling without requiring a serial-drive implementation first.

The replacement does change transport timing. The report records this as a functional service, not a verified reproduction of IEC handshaking or drive CPU behavior. Decompression has not yet been raised into a fully named, independently checked TypeScript algorithm; the source addresses remain available for that work.

## An overlapping-instruction trick

At `$CF04`, the normal refill path executes `BIT $68`, followed by `PLA` at `$CF06`. The operand byte at `$CF05` is itself the opcode for `PLA`; the end-of-stream branch can enter there to unwind an extra stack entry. Two entry points interpret overlapping bytes differently.

The ordinary `BIT` reads an unrelated BASIC scratch byte. Its N/Z results are replaced by the following `PLA`, and the decompressor does not test V. The startup annotation skips that unused read, guards the surrounding bytes and records the occurrence. Unknown overflow state remains outside the parity claim. This is a reviewed optimization for this path, not a general rule that BIT reads can be ignored.

## System services are explanatory code too

`KernalServices.clearScreen` describes screen clearing as rows, columns, line pointers, character memory and colour memory. It preserves the documented register, flag and stack effects for its supported inputs. Its CPU counts are checked separately from video DMA and interrupt timing. The behavior is based on the documented [screen-clear entry](https://skoolkid.github.io/sk6502/c64rom/asm/E544.html), [cursor home](https://skoolkid.github.io/sk6502/c64rom/asm/E566.html), [editor pointers](https://skoolkid.github.io/sk6502/c64rom/asm/E56C.html), [line clearing](https://skoolkid.github.io/sk6502/c64rom/asm/E9FF.html) and [colour pointers](https://skoolkid.github.io/sk6502/c64rom/asm/EA24.html).

The small VIC and CIA services expose raster position, interrupt latches, keyboard ports and timers. IRQ entry saves the interrupted state and dispatches through the writable vector; its exit restores the state. These follow the [KERNAL entry](https://skoolkid.github.io/sk6502/c64rom/asm/FF48.html) and [exit sequence](https://skoolkid.github.io/sk6502/c64rom/asm/EA31.html). The default IRQ implements the [keyboard scan's no-key result](https://skoolkid.github.io/sk6502/c64rom/asm/EA87.html), including restoring the port lines after a paddle probe; scanning held matrix keys is still a gap. Composite reset and default IRQ services use approximate functional cycle and instruction counts. Audio writes are retained without sound synthesis in this bounded boot study; the browser runtime has separate approximate SID output.

## Read the menu pixels

`renderC64` decodes recovered memory rather than drawing a replacement logo. Character mode indexes eight glyph bytes per character. Bitmap mode groups eight rows per 8×8 cell, so its layout differs from a modern linear framebuffer. Multicolour modes turn each two-bit group into a double-width pixel. Cell colours and sprite data come from their original memory locations, following the [VIC register layout](https://www.oxyron.de/html/registers_vic2.html).

`menu.png` captures a static register snapshot. The menu's raster-dependent screen changes are not yet reconstructed, so the lower split-screen area can differ from the real display. The preview palette, colour-RAM upper bits, SID latch decay and cycle-level timing also remain outside hardware parity.

[The level chapter](LEVELS.md) follows the first two loads and spawns. [The digger chapter](DIGGER.md) explains assignment and terrain changes, and [the browser chapter](BROWSER.md) covers a checked first-level completion and static export. These later checks remain separate from this startup checkpoint.

The implementation lives in [`src/games/c64/lemmings/`](..): [`code/startup.ts`](../code/startup.ts) explains release hooks; `recovery/trial.ts`, `recovery/recover.ts` and [`recovery/boot.ts`](../recovery/boot.ts) run the scenarios. Media, CPU and C64 services stay shared with Nebulus. This boot report retains SID writes without synthesis; the separate browser runtime supplies [approximate sound](../../../../../docs/systems/c64/AUDIO.md), instruction bus slots and raster capture. Those gameplay checks do not upgrade this static menu image to hardware parity.

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
