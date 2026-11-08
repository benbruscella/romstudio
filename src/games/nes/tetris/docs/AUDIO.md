# The original music and effects driver

The original cartridge selects music and effects and writes the APU registers. The shared [PAL APU](../../../../../docs/systems/nes/AUDIO.md) models the voices and chip timing; the web controls do not contain a Tetris sequencer.

These are observed instruction sites in the supplied PAL PRG, not original author symbols:

| Original instruction               | Observed role                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `$E218`                            | Write `$C0` to `$4017`: five-step frame sequencing with the frame interrupt inhibited                      |
| `$E273–$E283`                      | Initialize the DMC DAC, pulse/noise envelope registers and triangle linear-counter register                |
| `$E067–$E06F`                      | Copy four bytes through two indirect pointers; on this route the destination is the pulse 1 register block |
| `$E98E`, `$E994`, `$E99A`, `$E9A0` | Write the four registers at `$4000,Y` through `$4003,Y`; Y selects pulse 1, pulse 2 or triangle            |
| `$E9F3`, `$E9F9`, `$E9FF`          | Write noise envelope, period and length/restart                                                            |
| `$E7C8`                            | Update pulse volume/envelope through an indexed store during the observed music/effects sequence           |

The indexed writer gets timer bytes from `$0680,Y` and `$0681,Y`. Other channel state comes from indexed RAM, including `$06C0,X`. This gives a useful division to study: the game turns music data and channel state into register values; the hardware turns those values into timed waveforms. The original mapper, instruction timings and controller polling continue alongside that work.

The 1,400-frame example advances the copyright/title and game/music/level menus, then moves, rotates and drops pieces and pauses/resumes. It produces 1,343,812 mono samples at 48 kHz, with peak magnitude approximately 0.418. Original and static execution compare each video frame's PCM. No DMC sample fetch is observed on this route, so this recording does not validate Tetris sample playback or every music selection.

`dist/work/games/nes/tetris/analysis/example.json` records effective register addresses, writer PCs and audio hashes; `analysis/example.wav` is available for local listening. Browser output comes from live game execution. Wider music/effects coverage, later game states and independent hardware fidelity remain unverified.
