# Nebulus / Tower Toppler startup

The second title uses the supplied NFI US release of **Tower Toppler**, provided in `roms/c64/nebulus/`. The local `VERSION.NFO` identifies John M. Phillips, joystick port 2, two trainers and PAL/NTSC compatibility. ROM Studio currently checks PAL startup only.

```sh
npm run cli -- boot --title nebulus
```

The command starts from the boot PRG, leaves the release screens, loads the second file, executes the original game initialization and captures the menu input loop. It emits a private report, RAM and known-memory snapshots, a menu PNG, observed instructions and generated TypeScript/JavaScript. To continue into the playable first-tower browser slice, run `npm run cli -- build-game nebulus`, then `npm run cli -- play --title nebulus`. [The gameplay chapter](GAMEPLAY.md) follows that continuation and its bounded input coverage.

## Media and launch

[The recipe](../recipe.json) pins disk SHA-256 `82c00a2d59c2614d0076479d397629eb7090872a8be615845c165295dd60ea46`. Original media and generated game assets remain excluded from the source repository. The static build includes the required assets for deployment.

| File             | Observed role                                                                   |
| ---------------- | ------------------------------------------------------------------------------- |
| `TOWER TOPPLER+` | Boot PRG, load address `$0801`, 7,046 bytes including its two-byte header       |
| `TOWER1`         | Subsequent KERNAL LOAD, load address `$0801`, 44,479 bytes including its header |

The first BASIC line contains the prefix `SYS2088` followed by release credits. Its next-line link points at the terminator, which the generic strict BASIC parser rejects. This recipe therefore checks the original SYS prefix at `$0805` and the machine-code bytes at `$0828` explicitly. It does not relax BASIC parsing for arbitrary files or evaluate the credits as an expression.

The packer consumes the KERNAL LOAD end pointer at `$AE/$AF`. Startup supplies that pointer from the extracted PRG's actual end, plus the stock LOAD vector `$F4A5` at `$0330/$0331`. Otherwise unknown bytes in `$0002–$0101` and `$0200–$03FF` receive a declared workspace fixture. Later BASIC activity and actual power-on RAM are not reproduced. The real-media test repeats startup with `$FF` workspace bytes and compares CPU state, game RAM from `$0400` upward and the captured image.

## A small, explicit CPU extension

The packer uses undocumented NMOS opcodes `$3C` and `$FC`, both indexed read-and-discard NOPs. At `$0150`, for example, `$3C` consumes the bytes that also encode `LDA #$FF` when entered at the following address. This is an instruction-skipping technique, not an unknown byte that can safely be ignored.

[The decoder](../../../../transpiler/mos6502.ts) keeps its default set of 151 documented instructions. [Recovery](../../../../transpiler/recover.ts) admits reviewed extensions only when the recipe requests them. [The lifter](../../../../transpiler/lift.ts) preserves the target read, the uncorrected-address read when indexing crosses a page, unchanged registers/flags, and four/five CPU cycles. No external emulator implementation is used.

The behavioral reference is the original investigation [NMOS 6510 Unintended Opcodes — No More Secrets](https://zxe.io/depot/documents/technical/NMOS%206510%20Unintended%20Opcodes%20-%20No%20More%20Secrets%20v0.96%20%282021-12-24%29%28groepaz%29%28en%29%5B%21%5D.pdf), particularly the NOP and indexed-read sections. Independent fixtures check reads, flags, timing and 16-bit wrapping; unsupported opcodes still fail.

## Release code and disk loading

[The title adapter](../code/startup.ts) contains the reviewed release boundaries. The original unpacker first expands the release payload and jumps to `$690C`. That routine XORs six pages with `$08` while copying `$6927–$6F26` to `$C900–$CEFF`. The last page includes unrecovered padding. The raised copy preserves its unknownness and includes the subsequent `JMP $CAD9` / `LDA #$00`, which overwrites the otherwise unknown final accumulator.

A fixture runs all original copy instructions on fully known input and compares the raised implementation's CPU state, all RAM, 7,708 instructions and 24,914 cycles. These counts exclude hardware stalls and interrupt preemption; the annotation requires inactive IRQ sources.

The observed `CHROUT` clear control uses ROM Studio's existing screen-clear implementation. A queued Space leaves the release intro. Joystick fire leaves the following picture without depending on its previous timer byte. These actions go through the original input paths.

The copied loader at `$0340` sets drive 8, secondary address 8 and filename `TOWER1`, then calls `$FFD5`. [The shared LOAD service](../../../../systems/c64/disk.ts) resolves that exact name against pinned disk files, writes the PRG payload and returns its end pointer. The original loader then changes the packed stub's `$0836` opcode to `STA` and jumps back to `$0828`. The second unpacker executes and transfers control to the game's `$8000` entry.

LOAD supports the observed PRG contract, including secondary-address destination selection. VERIFY, wildcard lookup, wrapping loads and destinations outside the declared RAM range stop explicitly. Serial handshaking, drive execution and disk timing are absent.

## Verification and current boundary

[The scenario](../recovery/boot.ts) follows sixteen completed visits to the original joystick reader at `$AB91` and stops before the next visit. That reader writes the CIA port, reads both ports and derives direction/fire values. The menu capture includes the title graphics produced by the game.

The scenario emits static functions from observed source-address/opcode pairs, with guarded opcodes and mutable instruction operands read as RAM data. A fresh run then uses those emitted functions and the same declared system/title services. Final CPU, RAM/knownness, device state, raster pixels, input actions and disk reads must agree. There is no recovery compiler or opcode decoder in `startup.js`. These generated functions are analysis artifacts that still require the ROM Studio harness; they are not a standalone game app.

[Tests](../recovery/boot.integration.test.ts) cover the CPU extensions, XOR copy and unknown padding, LOAD destination behavior and failures, pinned-media validation, complete startup replay and workspace sensitivity. Internal agreement does not establish hardware parity.

The release notes list two trainers. This scenario presses no trainer keys; their implementation and default settings remain unverified. [The browser build](GAMEPLAY.md) checks title music, Space-to-start, movement, delayed jumps, life loss and the tunnel/next-doorway Up sequence. Approximate SID synthesis, gameplay bus slots/read-ready waits and horizontal fine scrolling are implemented. This startup capture remains separate from those gameplay checks. Tower completion, later towers, other menu options, NTSC, exact sound/timing and independent hardware parity remain outstanding.

Implementation files live together in [`src/games/c64/nebulus/`](..). `code/startup.ts` owns release hooks, `recovery/boot.ts` owns this scenario, `recovery/game.ts` captures launch state, `recovery/build.ts` packages execution, and `web/title.ts` supplies browser labels and controls. On port 4174, **Play game** runs the original title music and **Space** or Fire starts gameplay; Restart returns to that title screen.

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
