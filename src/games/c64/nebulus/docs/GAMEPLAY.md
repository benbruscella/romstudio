# Nebulus's first tower in the shared player

The browser starts at the original title screen after the release screens and disk load. **Play game** enables the opening music and waits for **Space** or Fire. Native instructions then initialize the first tower. All movement, drawing, shooting, collisions, lives and timer changes execute recovered instruction functions. The adapter names state and input boundaries rather than replacing the game logic.

```sh
npm run cli -- build-game nebulus
npm run cli -- play --title nebulus
```

Open port **4174**, press **Play game**, then press **Space** when ready. Touch Fire or the first gamepad button also starts. Restart returns to the title screen and music. The checked example supplies its own start press.

Arrow keys provide joystick directions; Space shoots, or jumps when pressed while walking. Up/Down operate the original context-sensitive door/lift controls. The touch controls and standard gamepad feed the same pins. Pause, restart, speed, fullscreen and sound belong to the shared shell. Sound follows original SID writes at 1×; accelerated playback is silent. See [the audio chapter](../../../../../docs/systems/c64/AUDIO.md).

## From the title screen to the first tower

[The startup chapter](BOOT.md) covers the packers and second disk file. [The gameplay scenario](../recovery/game.ts) captures the menu with its declared screen-tail fixture. For analysis it also supplies three fire polls, stops at the first-tower loop `$80AB`, and captures a gameplay checkpoint. Manual browser play uses the menu checkpoint and waits for real input. No entity position, level flag, life counter or completion flag is set by the scenario.

The initial drawing code reads the screen RAM tail `$07E8–$0800`, outside the 1,000 characters cleared by the screen editor. Those otherwise unknown bytes are a declared launch fixture. The first-tower test varies them between `$00` and `$FF` and checks the captured tower and player state. They are not labelled recovered ROM bytes.

Nebulus also uses decimal SBC in its timer interrupt. Decimal arithmetic is now part of the shared NMOS CPU backend, with its distinct flag behavior. See [the CPU decimal notes](../../../../../docs/CPU-DECIMAL.md).

## The title adapter is small

[The Nebulus player](../player.ts) selects the original `$AB91` joystick reader and `$80AB` logic boundary. The original reader converts CIA pins to the direction/fire fields at `$24–$26`. The adapter reads the current tower index at `$4A`, lives at `$52`, and the packed decimal timer at `$64/$65`. The native game still draws its own HUD.

[The browser title definition](../web/title.ts) supplies text, controls help, statistic labels and learning links. [The common player](../../../../systems/c64/player.ts) owns execution, frame pacing, input recording, gap reporting and raster capture. [The common shell](../../../../web/app.ts) owns transport, keyboard/gamepad/touch input and canvas presentation. Lemmings uses those same modules with its own boundaries, statistics, skills and result interpretation.

## Recorded coverage and its limits

[The builder](../recovery/build.ts) recovers a mixed-control example and additional bounded routes for idle/respawn, both walking directions, directional fire, standing fire, vertical directions, diagonals and rapid reversals. Transition routes also release movement or directional fire for Up, at several different times, then release Up. A held-Up route missed the `$AFC1` branch reached by that transition. A regression runs the delivered program with 30 PAL frames of Right or Right+Fire, 20 frames of Up, then release.

That short transition did not cover the next doorway. The `two-tunnels` route follows the reported sequence: Right, Up through the first tunnel, Left, then Up at the next doorway/lift. The first passage rotates `$47` from `$10` to `$50`; the next Up selects `$9220` through a mutable call target. The route is recovered and replayed with video and sound. A separate delayed-fire route visits the SID branch at `$F311`, which holding direction and fire together at startup missed.

Build-time control-flow analysis also follows direct branches and calls through known game RAM at `$8000–$FFFF`, seeded from observed instructions. Drawing helpers extend into `$C000` and the original sound driver starts at `$F000`; restricting analysis to `$BFFF` missed branches in both. This includes untaken paths such as `$9B8F` without decoding arbitrary RAM or adding a browser interpreter. Unknown bytes, overlaps and unresolved indirect destinations remain recorded gaps; these extra static paths are not labelled executed coverage.

## Why the tunnel looked off-centre

Nebulus writes a horizontal fine-scroll value of four to `$D016`. The original graphics move four pixels right while sprite coordinates remain fixed. The renderer previously ignored those bits, leaving the doorway four pixels left of Pogo. The shared renderer now applies fine scrolling to character/bitmap pixels and their sprite-priority mask. It leaves the original sprite registers untouched. Tests cover offsets of 1, 3, 4 and 7, including multicolour pairs and retained character rows. This follows [Bauer's VIC-II reference, §3.4](https://www.cebix.net/VIC-Article.txt), rather than a title-specific position adjustment.

The builder emits one guarded static program. Gameplay routes replay from the first-tower checkpoint; title routes replay from the menu. Each comparison uses its own original launch state and must match CPU/RAM/devices and input logs. Capture-enabled routes also compare pixels and SID samples. Separate checks require idle title input to keep waiting with audible music and fire to reach the native tower loop. The delivered example starts at that same title checkpoint.

Implementation files are grouped in [`src/games/c64/nebulus/`](..): release hooks in `code/startup.ts`, analysis and packaging in `recovery/`, execution adaptation in `player.ts`, and browser definitions in `web/title.ts`. Shared devices, rendering, audio and execution remain outside this folder.

The example demonstrates controls. It does not claim tower completion. The overall title remains partial, and unobserved source/opcode shapes stop explicitly. Later towers, completion, menu options, exact SID sound, full audiovisual fidelity and independent hardware parity remain unverified. The build is prepared locally for static deployment and contains the supplied game's recovered assets.

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
