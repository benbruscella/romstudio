# The first browser slice

ROM Studio can now export and play “Just dig!” locally. The browser starts at the recovered first-spawn checkpoint, accepts C64 joystick and keyboard inputs, and can finish the level. This is a partial title build covering level 1; progression, other levels, exact SID sound and independent hardware parity remain outside its acceptance.

```sh
npm run cli -- build-game lemmings
npm run cli -- play --title lemmings
```

`build-game lemmings` executes the disk boot afresh, records a completion route, emits static code, checks the static replay and packages `dist/work/games/c64/lemmings/`. `play` serves that export on the printed loopback URL, building it first if missing. After changing source, run `npm run cli -- build-game lemmings` again and refresh the page. The preview adopts a rebuilt package only after checking every declared file; invalid replacements return an error. Servers started before this refresh support need one restart. Ctrl-C stops the server. The package is a static directory and can run from a static HTTP host without a server-side emulator. The deployment step collects verified files into `dist/site/`; building does not publish them.

## Playing

Press **Play game**, or tap the screen. Arrow keys move the crosshair, `8` selects the digger, and Space fires. The onscreen buttons provide touch input. A standard gamepad uses the directional pad/left stick for movement, its first button for fire and its second button for the digger. All these controls supply CIA pin or keyboard-switch states; they do not directly set entity positions, skill stock or terrain.

Pause, restart, speed, fullscreen and sound controls belong to the common shell. [Approximate SID sound](../../../../../docs/systems/c64/AUDIO.md) follows the original register writes and plays at 1× speed after Play. Pause and mute clear queued sound. Save/resume is not offered. The visible C64 toolbar and game graphics come from recovered memory. Rendered raster lines retain active sprite rows, fetched sprite bytes, character-bank changes and character/colour row latches. Generated instruction accesses now use bus slots and wait through the VIC's badline/sprite read-ready windows. Per-column fetches, half-cycle effects and composite ROM-service timing remain incomplete.

**Play checked example** restarts the checkpoint and plays recorded controls at 4× speed. It assigns one digger, opens a passage and rescues six lemmings. Two others die from falls. The example then uses the original double-Delete nuke action to end the two trapped lemmings. The native engine reaches its end-of-level path with six rescued and no active lemmings: 60%, against the header's 50% requirement. The browser reports the result from those counters, the native end flag and the decoded requirement. It does not claim that the original post-level result screen or progression code has been exported.

## Static translation and self-modification

The analysis runner dynamically recovers exact instruction-byte variants. The browser package contains neither that compiler nor an opcode decoder. [The static emitter](../../../../transpiler/static.ts) generates source-address functions from recovered address/opcode pairs. Its dispatcher maps observed address/opcode pairs to those emitted functions; this keeps dispatch efficient for larger titles too.

This needs an explicit lowering rule for the game's self-modifying operands. A generated function guards the recovered opcode at its source address, then reads the instruction's operand bytes as data. The opcode still fixes the mnemonic, addressing mode, width and timing expression. An unobserved address/opcode pair stops with an unsupported-path message; the browser does not silently compile it.

This is a reviewed first-level lowering, recorded in `manifest.json`. It differs from the generic lifter's default exact-byte guards, which still reject changed operands. The tests compare both forms across all 151 documented instruction shapes and varied operand values. Trace coverage includes the completion route and cursor sweeps with the default skill and the digger selected. Both sweeps exercise scrolling, all eight movement directions, reversals and release. The build requires all four cursor limits to be reached and replays both sweeps with the exported static functions, comparing full machine state and recorded inputs. Reaching a new branch can still expose an unrecovered shape; these routes are not complete gameplay coverage.

Shared build-time control-flow analysis now also follows direct branches and calls through the known game-code region `$0800–$3FFF`. It recovered the `$0DAF` branch reached during a mixed Up/movement/skill sequence. Static reachability is reported separately from executed trace coverage. The analysis neither decodes arbitrary RAM nor supplies a browser interpreter; unknown bytes and unresolved indirect destinations remain explicit gaps.

The earlier sweep's fifty-frame vertical legs missed the bottom limit after moving to the top. Ordinary Down movement then stopped at the unrecovered `$17E8` instruction: the original code loads 167 and writes it to cursor Y at `$B8` after an update exceeds that boundary. The longer sweeps retain this branch. `manifest.json` records their reached coordinate bounds (`X=4–83`, `Y=17–167`, in the engine's cursor units) and static replay results. A separate regression runs Down and both downward diagonals for 200 video frames each using the delivered module and renderer.

The package retains `game-code/program.ts`, `game-code/program.js`, generated address pages and `game-code/shapes.json`. Comments in generated functions identify the original address and a representative recovered instruction. In the parameterized form, the current operand comes from RAM rather than that representative comment. The named [digger routines](../code/digger.ts) remain the checked teaching implementation; the browser's timing path currently uses emitted instruction functions.

## The same player as Nebulus

Lemmings and Nebulus now use one [C64 player](../../../../systems/c64/player.ts), [controller protocol](../../../../systems/c64/input.ts), browser shell and static packager. The [Lemmings adapter](../web/title.ts) owns its labels, skills, statistics and level result. Its recovery scenario and named digger implementation remain title-specific. See [the shared architecture](../../../../../docs/ARCHITECTURE.md) for the boundary and source links.

Lemmings code is grouped under `src/games/c64/lemmings/`: `recovery/build.ts` packages the game, `recovery/controls.ts` supplies example inputs, `player.ts` adapts execution, and `web/title.ts` supplies the browser definition. The export uses `games/c64/lemmings/web/title.js`. The shared shell also supports Nebulus's optional “Press Space to start” prompt; Lemmings continues to start at its first-spawn checkpoint.

The shared renderer now applies `$D016` horizontal fine scrolling to background pixels and their foreground mask while retaining independent sprite coordinates. Nebulus exposed the missing four-pixel shift at a doorway. Independent pixel fixtures cover offsets of 1, 3, 4 and 7 and odd-offset multicolour pairs. See [the Nebulus explanation](../../nebulus/docs/GAMEPLAY.md); this adds no title-specific coordinate adjustment.

## A checkpoint includes the machine around the game

Copying RAM alone does not resume a C64 game. [Checkpoint capture and restoration](../../../../systems/c64/snapshot.ts) retain the CPU state, known-memory mask, processor-port banking, VIC raster clock/comparison/interrupt latches, CIA timer latches/counters/interrupt state and keyboard pins, colour RAM and SID write state. Analysis caches and byte-writer metadata are excluded.

Restoration validates sizes and ranges, and restores the actual processor-port byte after constructing the bus. Otherwise a constructor's ROM-banking default would replace the checkpoint's active RAM mapping. Tests check unknown RAM, pending interrupts, timer advancement and held switches after restoration. The existing launch fixtures remain declared in [the level chapter](LEVELS.md).

## Why the initial display lost whole bands

Lemmings reuses the eight hardware sprites as strips of the terrain display. In the first-level trace, sprites 0–3 start with Y=51. The engine writes their next Y=72 while their existing images are still being displayed. The initial renderer calculated each row from the current Y register. That erased the remaining rows of the old image, leaving the large black bands visible in the first browser build.

The white count panels above unavailable skills have a different explanation: screen row 22 selects the recovered `$47/$52` glyphs, whose inner rows are filled pixels. Those panels are present in the game's data and remain in the corrected display.

[The raster display](../../../../systems/c64/raster.ts) now keeps each active sprite's row counter independently of its Y register. A later Y write prepares another use; the current image continues through all 21 rows. Y expansion repeats fetched rows. Sprite fetches also retain their three bytes across pointer writes, using PAL's early/late fetch groups. The character display retains the forty screen codes and colours between bad lines, while glyph-bank selection can change. The pixel decoder treats multicolour pattern `01` as background for sprite priority and gives a lower-numbered sprite priority even when foreground graphics hide it.

These rules follow the independent hardware investigations documented in Christian Bauer's [VIC-II article, sections 3.6.3, 3.7.2 and 3.8](https://pc.sux.org/files/vic-article_html_engl_vic_article_1.pdf). The implementation is ROM Studio's own TypeScript. It groups each sprite's three-byte fetch and each character row's forty fetches; output colours and positions are sampled for a whole raster line. It does not claim to reproduce every bus phase. The read-ready timing added below now supplies CPU DMA waits during gameplay.

## Why thinner strips still remained

Keeping a sprite active fixed the largest missing bands, but pointer writes still happened too early. The original `INC $47F8` at `$0944` advanced the first terrain strip's pointer while the previous strip's last data fetch was pending. ROM Studio had applied both RMW writes at the instruction's start and omitted VIC read-ready waits.

[The CPU runtime](../../../../runtime/mos6502.ts) and [lifter](../../../../transpiler/lift.ts) now place accesses in their instruction slots. [The raster sequencer](../../../../systems/c64/raster.ts) supplies the PAL badline and sprite BA windows; [the shared player](../../../../systems/c64/player.ts) clocks the devices and waits on reads, allowing pending writes to complete. In the captured example, the pointer change moves from line 71 to line 72, after the previous strip's last fetch and before its reuse. This removes the thin horizontal discontinuities without patching terrain pixels or changing the original rendering routines.

[Clock tests](../../../../runtime/mos6502-clock.test.ts) exercise every documented instruction shape, indexed accesses, RMW writes and stack slots. Synthetic display tests use an original-instruction `INC` to verify all 21 rows and adjacent sprite reuse across both PAL fetch groups. The real-media web test independently compares 3,744 terrain-only pixels with the game's terrain lookup, covering each strip boundary. This is stronger evidence for the image than replaying the same renderer twice.

The narrow playfield itself belongs to the original C64 design: Thomas Mittelmeyer describes using a sprite multiplexer for the background in [his contemporary development diary](https://www.zzap64.co.uk/zzap99/lemmingsdiary1.html). The black horizontal seams were a ROM Studio timing defect.

[Video tests](../../../../systems/c64/render.test.ts) specify expected pixels directly: a full 21-row image must survive an early Y write, retain data fetched before a pointer change, and continue into a second image. Sprites from both PAL fetch groups are covered. Further fixtures check 42-row Y expansion, retained screen codes/colours, live glyph-bank changes and overlapping sprite/background priority. These checks are separate from comparing the same renderer in two execution paths.

## Verification and limits

[The export builder](../recovery/build.ts) runs a fresh original-instruction recovery from the checkpoint through completion. It records input changes at the same control-entry boundaries used by the browser player. The static replay then compares final CPU state, RAM, knownness, device state, raster pixels, input log and level result with that recovered execution.

The first checked build recovered 2,922 address/opcode shapes from 9,656 exact-byte variants across its completion and cursor traces. These are coverage observations, not a count of all game code or every possible self-modification.

`manifest.json` marks this executable first-level study as `partial-title`; the library offers **Try study**, while **Play Game** requires separate release acceptance. It records file hashes, reference replay checks, lowering rules, source media/build identity and limitations. The local server serves only declared files with matching hashes; analysis outputs and neighbouring workspace files are excluded.

This establishes consistency between ROM Studio's recovery and static execution on the checked route, including generated SID samples. It is not an independent hardware trace. Exact SID sound, cycle-level video/interrupt fidelity, special-terrain rules, broader input coverage, original result screens, progression and the rest of the title still need work.

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
