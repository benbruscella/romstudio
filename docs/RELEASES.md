# Releases and retained decisions

This is ROM Studio's durable record of release scope and agreed decisions. [Project status](PROJECT-STATUS.md) records current implementation and evidence; the [specification](SPEC.md) defines technical behavior; [Blue sky](BLUESKY.md) holds ideas beyond committed scope. There is no separate MEMORY.md.

## v0.1 — unreleased

**Six excellent games across three systems, plus the ROM Desk workbench.** Both are required. The owner reaffirmed the six-game scope and included the workbench on 8 November 2026. A one-game release, a collection of demos or a read-only source viewer does not meet this commitment.

| System       | Required games                           |
| ------------ | ---------------------------------------- |
| Commodore 64 | Lemmings, Nebulus / Tower Toppler, Elite |
| NES          | Super Mario Bros., Tetris                |
| Nintendo 64  | Super Mario 64, European revision 0      |

### Product and architecture

ROM Studio makes original games playable on the web and makes their engineering understandable. The delivery path is **ROM → TypeScript → Web**, with static JavaScript compiled from TypeScript. **The one excluded technology is Emscripten:** ROM Studio does not ship a native engine compiled for the browser. Original translated instructions, checked named interpretations, system hardware and web presentation have separate responsibilities.

### Execution tiers — decided 9 November 2026

The owner made full-speed play the priority and narrowed the hard architectural rule to **no Emscripten**. WebAssembly, GPU drawing, high-level implementations of system microcode, compiled blocks and parallel workers are no longer excluded by policy. Each still needs a measured benefit and verification against the reference tier. Two tiers separate playing a game from explaining it exactly:

| Tier           | Purpose                          | What it runs                                                                                                                                           | Speed                    |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Reference tier | Verification, Learn and ROM Desk | Original instructions for every processor, one functional step at a time, with the software renderer and per-tick device references                    | May run below full speed |
| Play tier      | **Play Game**                    | The same recovered game code, plus faster implementations of the system work beneath it: for N64, recognized RSP microcode, RDP drawing and scheduling | Full speed is the target |

The tiers coincide for the C64 and NES games, which already have adequate speed on the reference path. SM64 is the first game that needs a separate play tier. The play tier keeps these constraints:

- **Game logic is never replaced.** Game CPU code still comes from the recovered translation; it may be compiled into larger guarded blocks. Named interpretations are explanations, not play-tier substitutes.
- **System work may be implemented at a higher level.** A recognized N64 microcode, identified by its IMEM/DMEM bytes, may run as a ROM Studio TypeScript implementation of its documented commands. Unrecognized microcode runs its original instructions; the play tier does not guess.
- **Pacing and output stay honest.** Do not change PAL timing, skip game work or mute/drop samples to manufacture a speed claim.
- **Tier changes happen at declared boundaries.** For N64 that is between RSP tasks, where RDRAM, CPU and device state agree. Entering ROM Desk from Play hands state to the reference tier; Desk does not step play-tier internals.
- **Acceptance compares the tiers.** Recorded input routes must produce the same game state at frame boundaries and the same PCM stream where the implementation permits it. GPU-drawn pictures may differ by device, so they need a declared image tolerance against reference-tier frames.

#### Implications for the project goals

- **Recoverable game code:** unchanged. The game's own instructions, source maps and named interpretations remain the subject of Learn.
- **Play, Learn and Desk:** Learn and Desk explain the reference tier. Inside Play, RSP microcode and RDP internals are not steppable; pausing into Desk switches tiers at a task boundary.
- **Multiple systems:** a high-level implementation covers one microcode family. Another N64 game with different microcode starts on the reference tier until its microcode has a verified play-tier implementation.
- **Reproducibility:** tick-exact original/static replay remains the reference-tier acceptance. Play-tier task timing differs, so its evidence compares game state, PCM and pictures on recorded routes rather than tick-identical machine hashes.
- **Education:** high-level microcode implementations are ROM Studio's readable account of Nintendo library behavior, not recovered original code, and must be labelled that way.
- **Documentation:** statements that excluded WebAssembly or kept GPU code removed are superseded by this decision.

MAMEKIT explains machines from MAME source; ROM Studio explains games from original binaries. [Inspiration](INSPIRATION.md) credits related work and identifies improvements to adopt. Browser delivery alone does not meet the educational goal; readable routines, data structures, source mappings and explanations are required.

### Six-game quality bar

Each game needs reliable original startup and controls, appropriate sound, sustained normal play, loading/progression, restart and game-over behavior. Nebulus must retain its original title music and wait for Space/Fire. Recorded failure routes remain regressions, including Lemmings cursor/terrain issues, Nebulus tunnel/Up transitions and Elite sustained title input.

Use the supplied game's correct system and regional timing. The owner confirmed this after the PAL Mario music review: retain the cartridge's original tempo rather than introducing a slower soundtrack override. Full-speed browser execution remains the performance target, including SM64; the reported 4 FPS is a development blocker, not release acceptance. Optimize translated execution and presentation while preserving game state and device-event ordering.

Opening a game page must run its original startup/title/attract sequence automatically, without a host Play click. The game's own Start/Space input begins play. Browser sound unlocks on an interaction; enabling audio must not reset the game. The host provides Restart, pause and sound controls. A game package that still launches from a gameplay checkpoint must label that limitation rather than invent a replacement attract mode.

Each game also needs useful Learn material: original bytes/assembly linked to generated TypeScript, meaningful checked routine names, memory/data explanations and evidence for graphics, input, sound and game state. Partial opcode coverage and one successful example cannot stand in for excellent game support. Independent hardware accuracy and internal replay consistency remain separate claims.

### ROM Desk workbench — required for v0.1

The workbench is part of the release, not an optional future add-on. Its core must work with all six supported game studies and their three systems:

- Load and identify supported original media by hash, select its matching study/build and explain unsupported releases. Arbitrary unknown binaries are not automatically runnable.
- Run, pause and restart the actual translated game on the reference tier; step instructions and frames. On N64, identify CPU versus RSP execution explicitly. Opening Desk from Play transfers state at a declared tier boundary without resetting the game.
- Synchronize the current instruction, original bytes/assembly and generated TypeScript. Show checked named interpretations where available, with bank/address-space/epoch identity and clear annotation limits.
- Inspect registers, flags and memory from the same paused execution point. Show useful source-aware stops and address breakpoints without inventing game behavior.
- Show basic system diagrams connecting CPU, memory, video, sound and input to the modeled devices. Label teaching diagrams distinctly from attributed original electrical schematics.
- Connect Play, Learn and Desk through compact, accessible browser navigation and direct history URLs. Keep controls usable on desktop, laptop and narrow screens.

Debug commands must act on the real system adapter and the reference tier's static game functions; a browser decoder or dynamic compiler is not introduced to make unsupported code appear to work. Desk may run below full speed. **Implemented on 10 November 2026** as described in [ROM Desk](DESK.md). Its stepping-agreement tests pass for all six games: instruction stepping reaches the same registers, cycles and memory as ordinary frames. Owner review of the workbench is still required.

Advanced rewind/time travel, pixel-to-instruction archaeology, semantic breakpoints, editors, community remix galleries and multiplayer remain [Blue sky](BLUESKY.md) ideas unless separately promoted into a release.

### Verification and delivery

Release acceptance includes checks/tests on the actual candidate, original/static replay, game-specific behavior assertions, source mapping checks, controls/audio/performance review and all six games in the workbench. Stepping must agree with ordinary execution at the same machine boundary, and paused inspection must not advance the game. Unsupported paths retain diagnostic provenance. Where a game has a separate play tier, release acceptance also compares it with the reference tier on recorded input routes: game state at frame boundaries, PCM and pictures within their declared tolerance.

### Six games accepted as working — 9 November 2026

The owner, having played them, accepted all six games as working: Lemmings, Nebulus, Elite, Super Mario Bros., Tetris and Super Mario 64. Their packages are now `release-ready` and the library offers **Play Game**. Each game's documented limits still apply and remain in its README and status entry; for SM64 these include unaccepted saves and progression, and a title screen that averages 24.0 fps rather than a steady 25 since the audio implementation (10 November). `build --deploy` still also requires verification passed for the current sources. The ROM Desk workbench, also required for v0.1, was implemented on 10 November ([DESK.md](DESK.md)).

### Build, test and deploy — decided 9 November 2026

The owner separated building from testing. **Build packages; tests verify; deploy is strict.** Previously each game's build reran original recovery and its original/static comparison, so a renderer fix took half an hour to reach `npm run dev`.

| Step   | Command                                                                  | What it does                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build  | `npm run build`, `npm run dev`                                           | Packages every game from its saved recovery capture with the current compiled code, then assembles the site. `dev` also serves and rebuilds on changes. A package records whether its verification is current for the sources it was built from. |
| Test   | `npm test`, `npm run cli -- verify-game <system/game>`                   | Reruns original recovery and the original/static comparisons, then records the result. Integration tests use it.                                                                                                                                 |
| Deploy | CI: `npm run build -- --deploy` (PRs then run `npm test -- integration`) | Runs `verify-game` for every game in parallel instead of packaging from captures, then requires every required game to be release-ready and verified for the current sources. There is no separate release script.                               |

A recovery capture is reused until the media, recipe or recovery scenario changes; it is input for packaging, never evidence that changed code passed. `dist/` stays disposable: a build creates any missing capture or package, and only verification runs the comparisons. SM64 keeps its captures in git-ignored `.cache/`. The C64 and NES builders recover without the comparison during `build` (`verify: false`, recorded as `not-run`) and reuse an existing package. CI starts from nothing, so the deploy build verifies every game itself; the integration tests check recovery in temporary folders and do not leave packages behind. The scripts were reduced to `dev`, `build`, `test`, `check`, `fix` and `cli`.

The strict deploy build enforces game readiness and verification. ROM Desk ships in every game package; its stepping-agreement checks run with the integration tests (`src/web/desk/stepping.integration.test.ts`) and the workbench checklist in [Testing](TESTING.md) is the owner's review.

Generated output stays under `dist/tools/`, `dist/work/` and deployable `dist/site/`. Routes use browser history. Deployment: [BUILD.md](BUILD.md#ci-pull-requests-and-main).

### Working order

All six games are owner-accepted as working. The ROM Desk workbench is the next and largest remaining v0.1 item. Continue toward the workbench and the documented game limits, using completed game behavior and explanations as the measure of progress. Arcade, Saturn, Xbox and additional games do not expand v0.1. Smaller implementation milestones do not reduce the agreed release scope.

SM64 now has checked original menus/opening and live movement/jump/B actions. The play tier (high-level Fast3D graphics, RDP drawing in a parallel worker, compiled CPU blocks and real-time pacing) reaches PAL 25 fps on the castle fixture; the title screen ran at about 18 fps because its audio still ran the original RSP microcode. A high-level implementation of that audio microcode (10 November) matches the original's output byte for byte and runs the title workload 1.40× faster in Node; in Chrome the title now averages 24.0 fps (from about 18). Saves and ordinary progression remain unaccepted. [Performance evidence](../src/games/n64/sm64/docs/PERFORMANCE.md) distinguishes the measured scopes and retained references; no v0.1 release or deployment has been approved.

The GPU experiment was removed, including its archived code and test artifacts, after it failed to establish a meaningful speed gain. Focus remains on translated CPU/RSP execution and the software renderer. Full-speed acceptance remains required. _(Superseded on 9 November by the execution tiers: GPU drawing may return in the play tier once RSP microcode cost no longer dominates. The earlier experiment drew on the GPU while CPU/RSP execution still set the pace.)_

The owner reaffirmed the SM64 full-speed target and supplied detailed performance findings. Keep **software scanlines → guarded RSP blocks → event-deadline execution** as the investigation order. Binary64 already represents signed 48-bit accumulator integers exactly; integer pairs need a measured speed benefit and are not an accuracy fix. GPU code remains removed. Do not change PAL pacing, skip work or mute/drop samples to manufacture a speed claim. _(The investigation order and "GPU code remains removed" are superseded by the execution tiers; the pacing and output rule still applies.)_

On 9 November the checked software scanline package passed its complete earlier-original endpoint/PCM comparison and a fresh browser title test, 3.48 → 4.44 completed tasks/second. Larger block/scheduling prototypes remain under evaluation. Node's restricted optimization tier differs substantially from Chrome; evaluate the actual rebuilt browser before making performance acceptance decisions. Full-speed sustained play, usable sound, saves/progression and the six-game/workbench release scope remain required.

Later on 9 November the owner adopted the [execution tiers](#execution-tiers--decided-9-november-2026). Reference-tier optimizations have produced 25–64% steps, while broader block experiments gained about 1%; full speed needs roughly seven times the current throughput. The SM64 order is now: measure RSP time per task type; build play-tier implementations of the recognized audio and Fast3D graphics microcode, verified against reference-tier PCM and frames; move RDP drawing to a parallel worker or the GPU if measurements still fall short; then compile hot CPU blocks where measured. The reference tier stays the verification baseline for Learn and Desk.

## Retained project decisions

The following record is preserved from PROJECT-STATUS.md so release decisions and project memory have one home. Implementation progress and validation results belong in [Project status](PROJECT-STATUS.md).

| Request / decision            | Current implementation or acceptance condition                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename ROMKIT                 | Product **ROM Studio**, npm package `rom-studio`, CLI **`roms`**; source folder is still the existing `romkit` checkout                                                                  |
| README logo                   | New cartridge/code wordmark in `docs/assets/rom-studio-logo.png`                                                                                                                         |
| No VICE                       | Media parsing, CPU translation and hardware services are implemented here; no external emulator dependency or fallback                                                                   |
| Only hard engine rule         | No Emscripten (9 November 2026). WebAssembly, GPU drawing and high-level microcode implementations are permitted when measured and verified                                              |
| Two execution tiers           | Reference tier for verification, Learn and Desk (may be slower); play tier for full-speed Play, checked against the reference on recorded routes                                         |
| Keep C64 Lemmings disks       | Original three-disk Alpha Flight release remains the first trial; no switch to a console version                                                                                         |
| Skip typing LOAD              | Original startup is run during recovery; browser launch uses a declared checkpoint                                                                                                       |
| Educational game code         | Named interpretations, assembly/source mappings, memory maps, chapters and checked evidence, inspired by Contra                                                                          |
| Benchmark                     | At least Contra-level explanation per completed game study, across multiple systems; automatic lifting alone is insufficient                                                             |
| Original game vs browser code | `game-code/` generated assembly translation, `src/games/*/code/` interpretations, `src/systems/` hardware, `src/web/` presentation                                                       |
| Add Nebulus                   | Second C64 title; bounded first-tower coverage, original title/start flow and SID audio                                                                                                  |
| Reported Up failure           | Reproduce Right → Up through first tunnel → Left → Up at next doorway/lift; cover `$9220` selected indirectly                                                                            |
| Tunnel alignment              | Shared VIC-II fine-scroll fix; background was four pixels left of native sprite coordinates                                                                                              |
| Opening music then keypress   | Nebulus Play should run original title music and wait for Space/Fire; Restart returns to title                                                                                           |
| Audio                         | Approximate original SID register-write synthesis for C64; exact analogue fidelity unverified; NES PAL APU, original/static per-frame PCM and live browser output checked for SMB/Tetris |
| Lemmings visual corruption    | CPU bus-slot timing and VIC read-ready waits implemented; independent terrain pixels and native/static raster checks                                                                     |
| Lemmings cursor gap           | Default/digger sweeps exercise cursor limits; preserve these regressions                                                                                                                 |
| Add Elite                     | Pinned original disk, new commander, docked status, launch and flight/view replay verified                                                                                               |
| Add NES                       | NROM/MMC1, PPU, PAL NMI, controllers and DMA; SMB/Tetris native/static startup and control routes verified                                                                               |
| Add N64 for v0.1              | Sixth required game: SM64 EU revision 0; CPU/audio startup and first textured task verified; title-to-opening replay recorded; worker player unaccepted                                  |
| Game folders                  | Source, recipes, adapters, tests and game docs live in `src/games/<system>/<game>/`; identity is system/game, separate from shared system hardware                                       |
| Game documentation            | Each game owns its README and `docs/`; shared guides remain under root `docs/`                                                                                                           |
| Messy tests                   | Tests colocated; `*.integration.test.ts` for private-media cases; runner discovers source files                                                                                          |
| Recipes folder                | Recipes moved into game folders; no parallel root recipe hierarchy                                                                                                                       |
| Remove .romkit                | Contents migrated to `dist/work/`; `.romkit/` and old `exports/` removed                                                                                                                 |
| Remove empty folders          | Remove obsolete empty source/test/docs folders after checking their contents; preserve media and protected tooling                                                                       |
| One output root               | `dist/tools/`, `dist/work/`, `dist/site/`                                                                                                                                                |
| Front page                    | System → game library, installed vs playable states, content-addressed original media                                                                                                    |
| Play and Learn                | Separate actions and history routes; Learn must show useful game explanations and original/code evidence                                                                                 |
| Too much above fold           | Compact play layout with one navigation row; laptop/desktop layout checked, final mobile regression pending                                                                              |
| Proper router                 | History API routes (`/c64/nebulus`), direct load, refresh and Back/Forward; GitHub Pages project-base fallback                                                                           |
| Clean scripts                 | `dev`, `build`, `test`, `check`, `fix`, `cli` (9 November 2026); one-game builds, verification and preview use `npm run cli --`                                                          |
| First CLI command             | `roms identify <file-or-folder> [--json]`, formats/hashes/evidence/pinned matches without executing input                                                                                |
| README usability              | Basic identify/dev/build workflow; internal recovery commands explained in `docs/CLI.md`                                                                                                 |
| Port conflict                 | Busy ports report a useful CLI error; alternate dev ports get separate output directories and watcher rebuilds are serialized                                                            |
| Deployable site               | Complete HTML/JS/CSS, verified game modules, learning material and SHA-256 media assets in `dist/site/`                                                                                  |
| GitHub repository             | https://github.com/benbruscella/romstudio                                                                                                                                                |
| Release approval              | Merges to main deploy; **tag v0.1.0 only after the owner approves the reviewed result**                                                                                                  |

SM64 performance follow-up: broad multiply/block and coupled-scheduler prototypes were rejected after browser measurements despite correct bounded outputs. Their reports and exact source archives remain in `dist/work/`; active source keeps the simpler path. A hashed FullSync-2100 castle fixture follows original controls from the checked opening endpoint. It supports repeated fixed-work browser checks of state, RDRAM/SP and complete PCM, with renderer CPU time recorded to distinguish host contention. Device deadlines, pure DMEM transfers and guarded RSP control-wait loops are the next experiments. Full-speed acceptance remains outstanding.

The checked SM64 default is now `b163e6c9…`, with all five opening replay comparisons, 277 accounted-for unit tests and three SM64 cartridge integration tests passing. Native controls pass from a declared original-input castle fixture. The matched wide-castle production-player comparison improves from 1.02 to 1.67 FPS (about 64%); the narrower changes beyond scanlines are within native-player timing noise. A moving hillside view still shows about 4–5 FPS. PAL 25 FPS, usable real-time audio and wider progression remain unaccepted. Earlier exports/analysis are retained locally; no push/deploy authorization has been given. Prepared render-state caching matched outputs but showed no meaningful gain; it remains in private analysis and was not added to production source.
