# Tetris reset, menus and input

The supplied PAL program chip is 32 KiB and its graphics chip is 16 KiB. The recipe declares an MMC1 board. Board identity is explicit: raw filenames and byte lengths alone do not establish wiring.

## Reset and bank selection

The reset vector points to `$FF00`. The original code clears decimal mode, disables IRQ handling, disables PPU output, waits through two PPUSTATUS polls and initializes the stack. `INC $FF00` writes to the cartridge's mapper interface; it does not modify ROM bytes. The MMC1 model handles the two writes of an NMOS read/modify/write instruction.

The original routines at `$ACBD`, `$ACD1`, `$ACE5` and `$ACF9` send five serial bits to MMC1 register regions. They configure mirroring and program/graphics bank selection before control reaches `$8000`. These are cartridge effects, separate from the CPU instruction semantics.

## Why two controller samples?

The reader at `$AB83` strobes `$4016`, then reads eight bits from both controllers. `$ABB7` invokes that reader twice. `$ABCB–$ABE7` keeps only buttons present in both samples and separates newly pressed buttons from buttons still held.

The named interpretation in [controller.ts](../code/controller.ts) is checked against that original two-player filter. `held = first & second`; `pressed` contains held buttons absent from the previous held state. This explains why a host key pulse must survive original sampling, rather than merely exist for a JavaScript event.

## From copyright to gameplay

The original cartridge draws its copyright screen, title, game/music selection and level selection before the playfield. The checked example advances those menus with Start, then moves and rotates pieces, drops them and pauses/resumes. A screenshot and original/static comparisons establish actual gameplay on this bounded route, rather than a recreated Tetris rules engine.

A second route exercises menu directions and a third waits at startup. Replays compare CPU, RAM, mapper/PPU/controller state, input and pixels. The generated listing is `dist/work/games/nes/tetris/analysis/original.asm`; generated TypeScript remains separate from the named input interpretation and browser adapter.

The study remains partial: later levels, game-over flow, exhaustive input timing and exact PPU behavior require wider checks. The routes also compare PAL APU state and per-video-frame PCM output. [Audio](AUDIO.md) explains the observed music/effects driver and the remaining hardware limits. The current launch's zero RAM fill is a declared fixture, not a measured power-on state.
