# From reset to the first world

The supplied PAL PRG is 32 KiB, with a separate 8 KiB CHR chip. Its recipe explicitly selects NROM and vertical nametable mirroring. These raw chip files do not have an iNES header from which to infer the board.

## What the original instructions do

| Source address | Observed behavior                                                                  |
| -------------- | ---------------------------------------------------------------------------------- |
| `$8000`        | Disable IRQ handling and clear the decimal flag                                    |
| `$8002–$8009`  | Write PPU control and initialize the CPU stack                                     |
| `$800A–$8012`  | Poll PPUSTATUS twice, waiting for vblank transitions                               |
| `$8014–$8027`  | Inspect retained startup bytes and the `$A5` marker before choosing the reset path |
| `$90CC`        | Clear the selected CPU-memory regions through a zero-page pointer                  |
| `$8031`        | Initialize the mode byte at `$0770`                                                |
| `$8034`        | Write the startup marker `$A5` to `$07FF`                                          |
| `$8E5C`        | Latch and read the controllers                                                     |

The native reset vector points to `$8000`; NMI points to `$8082`. The PPU's beam raises NMI; the CPU bus supplies stack/vector entry, and the original game performs its frame work. The browser does not initialize Mario's position or draw a replacement level.

## Controller input is code too

`$8E5C` writes one, then zero, to `$4016`. The helper at `$8E6A` reads eight serial values, shifts the bits into an accumulator and stores the result in `$06FC,X`. The player index selects `$4016` or `$4017`. The NES system adapter supplies the controller's serial pins; the original routine decides how to use them.

The browser's A button becomes bit 0 of the host's serial controller byte, but eight left rotations put the first returned bit in bit 7 of the game's assembled byte. These two representations should not be confused.

## Evidence and limits

Three bounded routes cover idle title display, Start, movement, run/jump combinations, pause/resume and mixed directions. Their static replays compare CPU, devices, RAM, inputs and pixels with original instruction recovery. The resulting screenshot shows actual first-world gameplay. This establishes those routes within the current machine model; full-world progression and independent hardware parity remain unverified.

The exact original listing is generated at `dist/work/games/nes/smb/analysis/original.asm`; delivered original-address TypeScript lives under `game-code/`. Names in this chapter describe observed behavior and are not original author symbols. The original sound driver feeds the PAL APU. The same routes now also compare PCM audio for every video frame; see [Audio](AUDIO.md) for observed register writers and hardware limits.
