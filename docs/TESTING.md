# Review v0.1 locally

Use the Node version in `.nvmrc`, then run:

```sh
npm ci
npm run check
npm test -- unit
npm run cli -- identify roms
npm test -- integration
npm run dev -- --port 4175
```

Integration tests and the full build require the pinned originals described in [ROMS.md](ROMS.md). A source-only checkout can run checks, unit tests and `npm run dev` to browse the learning material. `npm run build` packages games for local review; only `build --deploy` enforces the six-game gate before publishing. Integration tests run game verification: original recovery and original/static comparison for the current sources.

## Library and learning

- On the development library (4175), use **Learn** and **Try study** to test the experimental games.
- N64 browser play has not passed acceptance. Use its **Learn** studies below; a work-in-progress player or a locally built **Try study** entry is not a substitute for the required sixth game.
- Refresh `/c64/nebulus` and `/nes/tetris/learn`. Back and Forward should restore the right view.
- Open **Assembly → TypeScript** in Learn, search an address and select instructions. Original bytes and generated functions should agree; named chapters explain the game-specific meaning.
- At laptop and desktop sizes, the screen and run control should fit without duplicate large headings. On a narrow phone viewport, controls and learning content must remain reachable without horizontal scrolling.

## Games

| Game     | Try                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lemmings | The current first-level checkpoint runs automatically; move the crosshair with arrows, tap **8**, then **Space** over a walking lemming to assign a digger. Stock should fall from 10 to 9. Two Delete taps (Backspace on a Mac keyboard) end remaining lemmings. Restart, then play the checked example: it should rescue 6/10.                                                                                                                                                                                                                                                                                                                    |
| Nebulus  | The original title runs automatically and waits for Space. Enable sound to hear its music without resetting. Start, move Right, press Up at the first tunnel, move Left and press Up at the next doorway/lift. Check doorway alignment, direction + Space jumping, sound toggle, pause and restart back to the title.                                                                                                                                                                                                                                                                                                                               |
| Elite    | The original title runs automatically; press **N** for a new commander, then **Space**, then **F1** to launch. Try arrows/Space and the view controls shown on screen. These routes do not establish complete trading, combat or saving.                                                                                                                                                                                                                                                                                                                                                                                                            |
| SMB      | The original title runs automatically; use **Enter** for Start, arrows to move and the displayed A/B keys for jump/run. Test Start pause/resume and the checked example.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tetris   | Original startup runs automatically; use Start through the original menus, then arrows and the displayed A/B keys to move, rotate and drop pieces. Test pause/resume and the checked example.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SM64     | Run `npm run cli -- boot --title sm64 --until frame`; check CPU startup, RSP audio, clears, all 1,024 first-image texels and the complete rendered task. Inspect `analysis/render/first-frame.png` (16 nonblack pixels at the start of the logo animation). Open `/n64/sm64/learn/code`, search `80241800`, and compare its word with generated TypeScript. Use `code-rsp`, `code-rsp-graphics`, `code-rsp-textures` and `code-rsp-render` for the separate microcode studies. The shorter `--until textures` stage deliberately leaves the triangle unconsumed with `taskComplete: false`. Pixel precision and browser gameplay remain unverified. |

C64 sound is approximate SID synthesis. NES sound follows original PAL APU register writes with approximate analogue output. Both NES games pass original/static per-frame PCM replay and live browser audio checks; broader songs/effects and physical-console parity remain unverified. Startup runs without a Play click; use Enable sound or a game key to unlock audio, and confirm that doing so does not reset the game. A recovery-gap message is a real unsupported path: record the game, the route from Restart and the last keys rather than treating it as a successful test.

## Execution tiers

Where a game has a separate [play tier](ARCHITECTURE.md#execution-tiers), currently planned only for SM64, check it against the reference tier:

- Replay the recorded opening and castle routes on both tiers. Game state at frame boundaries and the PCM stream must match. Pictures must match exactly, or stay within the declared tolerance for parallel or GPU drawing.
- Confirm unrecognized microcode runs its original instructions rather than stopping or being guessed.
- Pause Play and open Desk: the game must continue from the same state on the reference tier, without a reset.
- Measure full speed in the actual browser build at the game's regional rate, with sound running.

## Workbench — required for v0.1

The core debugger is not implemented yet. For every game in [the release scope](RELEASES.md), acceptance must include:

- Load the supported original media and verify identity; mismatched versions remain identifiable rather than executing as a different build.
- Run, pause, restart and step actual instructions/frames on the reference tier; compare stepped and ordinary execution at the same boundary. Identify N64 CPU/RSP separately.
- Follow the current instruction between bytes, assembly and generated TypeScript, retaining bank/epoch/address-space identity and annotation limits.
- Inspect registers/flags/memory without advancing paused state, then hit an address breakpoint and resume without losing device work.
- Check basic system diagrams against the modeled devices and identify source attribution and simplifications.
- Verify Play/Learn/Desk navigation, direct history URLs, keyboard operation and desktop/laptop/narrow layouts.

These checks must be implemented and added to release acceptance; the existing six-game gate alone is insufficient.

## Publishing gate

After all six games and the workbench meet [release acceptance](RELEASES.md), verify the production artifact:

```sh
npm run build -- --deploy --domain romstud.io
npm run cli -- preview --port 4176
```

This strict build must report six ready games. An explicit `--studies` export is useful development evidence and does not pass this release condition.

Review [project status](PROJECT-STATUS.md) and [build/CI setup](BUILD.md). The Pages workflow deploys main updates after checks, tests and a verified build. The first source push, pinned-input upload and deployment still require the owner's explicit approval. Nothing in this checklist performs a push or remote setup.
