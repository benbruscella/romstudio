# How this cartridge drives the APU

Music and effects come from the original program. The shared [PAL APU](../../../../../docs/systems/nes/AUDIO.md) supplies the chip behavior; it does not choose songs or react to Mario's actions itself.

These addresses are observed instruction sites in the supplied PAL PRG, not original author symbols. The generated TypeScript keeps the same addresses.

| Original instruction | Observed role                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `$F2D1–$F2D9`        | Read mode `$0770`; when zero, write zero to `$4015`, disabling the channels                                                |
| `$F2DA–$F2E1`        | Write `$FF` to `$4017` (five-step sequencing, IRQ inhibited), then `$0F` to `$4015` (enable the four synthesized voices)   |
| `$F382`, `$F385`     | Write Y to pulse 1 sweep and X to its duty/envelope register                                                               |
| `$F38F–$F39C`        | Read a timer pair through Y from `$FF01`/`$FF00`, then write `$4002,X` and `$4003,X`; X selects the voice's register block |
| `$F3A0`, `$F3A3`     | Write the pulse 2 duty/envelope and sweep registers                                                                        |
| `$F8BC–$F8C2`        | Write noise volume/envelope, noise period/mode and length/restart                                                          |

For example, the indexed timer writer appears at one instruction address but reaches pulse 1, pulse 2 and triangle registers on the checked route. Preserving the effective bus address matters: an instruction's source address alone does not identify its sound channel. A high-timer write also reloads a length counter and restarts a pulse envelope, so replacing it with a host oscillator-frequency assignment would lose behavior.

The 900-frame example includes Start, movement, run/jump input and pause/resume. It produces 863,879 mono samples at 48 kHz, with peak magnitude approximately 0.487. Original and static execution compare PCM separately for every video frame. This route observes no DMC sample reads; DMC support is exercised by independent hardware fixtures, not inferred from this song.

Inspect `dist/work/games/nes/smb/analysis/example.json` for the register writers, input recording and sample hashes, or audition `analysis/example.wav`. The WAV is a local review artifact; the browser executes the sound routine live. Full-song coverage, every effect and independent hardware fidelity remain unverified.

## Why this version's theme sounds faster

The supplied `pal-sm-0 prg` is the PAL release. Its music driver uses different note durations from the Japan/USA cartridge; correct PAL playback still produces a faster ground theme.

The original instruction at `$F8D5` reads the duration table at `$FF66,Y`. On a 700-frame Start/ground-theme trace, 115 reads used the row at `$FF7E` (table offset `$18`). Every value in this PAL row is two thirds of the corresponding [NTSC duration row](https://github.com/Xkeeper0/smb1/blob/main/src/music-data.asm), which the NTSC ground-theme headers also select. For example, the PAL value at `$FF82` is 12 frames; the corresponding NTSC value is 18. That is about 240 ms on PAL versus 300 ms on NTSC. Accounting for the different video rates, this theme is about 25% faster. This calculation concerns the ordinary ground theme, not every song or the separate hurry-up modifier.

Browser measurements over 12-second gameplay windows checked both 44.1 kHz and 48 kHz AudioContexts. They ran at approximately 50 frames per second, queued samples within 0.1% of the expected rate, and used playback rate 1 with zero detune. The existing synthetic pulse test independently checks pitch against the PAL CPU divider. Changing the output sample rate is not changing this tune's tempo.

The passive original-table trace is `dist/work/smb-music-tempo-trace.json`; browser measurements are `dist/work/nes-tempo-browser.json`. These observations explain the reported fast music while retaining the original cartridge's timing. No soundtrack recording, tempo patch or machine slowdown is used.
