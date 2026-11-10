# Elite startup and the packed release

The pinned disk contains two Elite releases and supporting editor, cheat, picture and documentation files. The current recipe chooses `ELITE V1.1+`, loads its PRG at `$0801` and enters its BASIC SYS target `$080B`. The original packer executes; a filename or matching disk size is not accepted in place of the pinned SHA-256.

## The final compressed-byte marker

The unpacker copies executable code into low RAM and reads its compressed bitstream backwards. Its last read at `$0188` uses the pointer `$FE/$FF = $07EF`, below the loaded PRG. That RAM byte is unknown under the declared launch fixture.

The following instructions do not use its value: `LDY $FE` replaces N/Z, tests compare the pointer itself, and the selected exit executes `LDA #$37`, restores the processor port, enables IRQs and jumps to `$0801`. With IRQs disabled during the read, the byte cannot affect the reviewed exit path.

`code/startup.ts` therefore declares a guarded discarded-read annotation for precisely that pointer and instruction sequence. It preserves RAM unknownness, advances the original instruction count and timing, and leaves the following original instructions to execute. Synthetic tests compare the final CPU and pointer state against the original tail with several different marker values. This does not give arbitrary unknown RAM a default value.

## Scope

The builder also verifies the original release picture input, ten distinct N trainer replies, the original title input loop, new Commander Jameson, docked status, launch and bounded flight/view controls. CPU/device/input/pixel and approximate SID replay checks pass on those routes. This does not establish saved-commander loading, trading, combat outcomes or full progression. See [current status](../../../../../docs/PROJECT-STATUS.md).

## Original screen and keyboard services

The release trainer calls the documented [screen output entry at $E716](https://skoolkid.github.io/sk6502/c64rom/asm/E716.html) and the [keyboard-buffer entry at $F142](https://skoolkid.github.io/sk6502/c64rom/asm/F13E.html). The shared C64 KERNAL layer supplies bounded functional contracts for the observed screen controls and input. Screen editing/scrolling and precise service timing remain explicit limitations. The original game uses its own matrix scanner and IRQ keyboard-state routine; the browser supplies closed switches and joystick pins.

The title samples host controls at the original `$A90D` routine. N closes PA4/PB7, and F1 closes PA0/PB4. These enter the original new-commander and launch paths without writing game state directly. Full-frame raster capture is required: a single VIC register snapshot misses the split between the flight view and dashboard.

## Sustained title and arrow regression

The initial 400-poll title check was too short. Ordinary title animation reaches the uncovered `JSR $B60C` at `$B5C4` after poll 608, producing a browser recovery gap independently of which arrow is held. Recovery now exercises 5,000 polls of idle title animation and a separate 5,000-poll arrow/release sequence. Both long routes now pass original/static state, input, raster and SID comparisons alongside startup and flight replays. A real browser arrow sequence also passes beyond the former six-second stop. Elite remains an experimental partial title.
