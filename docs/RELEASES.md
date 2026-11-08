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

ROM Studio makes original games playable on the web and makes their engineering understandable. The delivery path is **ROM → TypeScript → Web**, with static JavaScript compiled from TypeScript. There is no Emscripten/WebAssembly engine in this plan. Original translated instructions, checked named interpretations, system hardware and web presentation have separate responsibilities.

MAMEKIT explains machines from MAME source; ROM Studio explains games from original binaries. [Inspiration](INSPIRATION.md) credits related work and identifies improvements to adopt. Browser delivery alone does not meet the educational goal; readable routines, data structures, source mappings and explanations are required.

### Six-game quality bar

Each game needs reliable original startup and controls, appropriate sound, sustained normal play, loading/progression, restart and game-over behavior. Nebulus must retain its original title music and wait for Space/Fire. Recorded failure routes remain regressions, including Lemmings cursor/terrain issues, Nebulus tunnel/Up transitions and Elite sustained title input.

Use the supplied game's correct system and regional timing. The owner confirmed this after the PAL Mario music review: retain the cartridge's original tempo rather than introducing a slower soundtrack override. Full-speed browser execution remains the performance target, including SM64; the reported 4 FPS is a development blocker, not release acceptance. Optimize translated execution and presentation while preserving game state and device-event ordering.

Opening a game page must run its original startup/title/attract sequence automatically, without a host Play click. The game's own Start/Space input begins play. Browser sound unlocks on an interaction; enabling audio must not reset the game. The host provides Restart, pause and sound controls. A game package that still launches from a gameplay checkpoint must label that limitation rather than invent a replacement attract mode.

Each game also needs useful Learn material: original bytes/assembly linked to generated TypeScript, meaningful checked routine names, memory/data explanations and evidence for graphics, input, sound and game state. Partial opcode coverage and one successful example cannot stand in for excellent game support. Independent hardware accuracy and internal replay consistency remain separate claims.

### ROM Desk workbench — required for v0.1

The workbench is part of the release, not an optional future add-on. Its core must work with all six supported game studies and their three systems:

- Load and identify supported original media by hash, select its matching study/build and explain unsupported releases. Arbitrary unknown binaries are not automatically runnable.
- Run, pause and restart the actual translated game; step instructions and frames. On N64, identify CPU versus RSP execution explicitly.
- Synchronize the current instruction, original bytes/assembly and generated TypeScript. Show checked named interpretations where available, with bank/address-space/epoch identity and clear annotation limits.
- Inspect registers, flags and memory from the same paused execution point. Show useful source-aware stops and address breakpoints without inventing game behavior.
- Show basic system diagrams connecting CPU, memory, video, sound and input to the modeled devices. Label teaching diagrams distinctly from attributed original electrical schematics.
- Connect Play, Learn and Desk through compact, accessible browser navigation and direct history URLs. Keep controls usable on desktop, laptop and narrow screens.

This is acceptance scope, not a claim that the debugger is implemented. Existing source views and checkpoints provide foundations. Debug commands must act on the real system adapter and static game functions; a browser decoder or dynamic compiler is not introduced to make unsupported code appear to work.

Advanced rewind/time travel, pixel-to-instruction archaeology, semantic breakpoints, editors, community remix galleries and multiplayer remain [Blue sky](BLUESKY.md) ideas unless separately promoted into a release.

### Verification and delivery

Release acceptance includes checks/tests on the actual candidate, original/static replay, game-specific behavior assertions, source mapping checks, controls/audio/performance review and all six games in the workbench. Stepping must agree with ordinary execution at the same machine boundary, and paused inspection must not advance the game. Unsupported paths retain diagnostic provenance.

The existing strict build enforces game readiness. Workbench implementation, acceptance checks and its release gate still need to be completed; passing the present game gate alone will not satisfy the expanded release scope. See [Testing](TESTING.md).

Generated output stays under `dist/tools/`, `dist/work/` and deployable `dist/site/`. Routes use browser history. The domain is **romstud.io**, with `/romstudio/` project-base builds retained. CI checks merged main updates before deployment. **The owner must explicitly approve the concrete reviewed v0.1 result before any initial push, input upload or deployment.**

### Working order

NES sound has completed bounded channel/bus, six-route PCM replay and browser acceptance. Continue with SM64 browser play next, preserving the agreed NES-first order. Continue toward all six games and the workbench, using completed game behavior and explanations as the measure of progress. Arcade, Saturn, Xbox and additional games do not expand v0.1. Smaller implementation milestones do not reduce the agreed release scope.

SM64 now has checked original menus/opening and live movement/jump/B actions. The latest local optimization candidate passes its captured-original endpoint/PCM comparison and improves the matched browser title workload by about 25%; live play remains around a few frames per second. The owner explicitly asked to keep improving speed. Full-speed gameplay stays required, alongside audio, ordinary progression and ROM Desk. [Performance evidence](../src/games/n64/sm64/docs/PERFORMANCE.md) distinguishes the measured scopes and retained references; no v0.1 release or deployment has been approved.

The GPU experiment was removed, including its archived code and test artifacts, after it failed to establish a meaningful speed gain. Focus remains on translated CPU/RSP execution and the software renderer. Full-speed acceptance remains required.

The owner reaffirmed the SM64 full-speed target and supplied detailed performance findings. Keep **software scanlines → guarded RSP blocks → event-deadline execution** as the investigation order. Binary64 already represents signed 48-bit accumulator integers exactly; integer pairs need a measured speed benefit and are not an accuracy fix. GPU code remains removed. Do not change PAL pacing, skip work or mute/drop samples to manufacture a speed claim.

On 9 November the checked software scanline package passed its complete earlier-original endpoint/PCM comparison and a fresh browser title test, 3.48 → 4.44 completed tasks/second. Larger block/scheduling prototypes remain under evaluation. Node's restricted optimization tier differs substantially from Chrome; evaluate the actual rebuilt browser before making performance acceptance decisions. Full-speed sustained play, usable sound, saves/progression and the six-game/workbench release scope remain required.

## Retained project decisions

The following record is preserved from PROJECT-STATUS.md so release decisions and project memory have one home. Implementation progress and validation results belong in [Project status](PROJECT-STATUS.md).

| Request / decision            | Current implementation or acceptance condition                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename ROMKIT                 | Product **ROM Studio**, npm package `rom-studio`, CLI **`roms`**; source folder is still the existing `romkit` checkout                                                                  |
| README logo                   | New cartridge/code wordmark in `docs/assets/rom-studio-logo.png`                                                                                                                         |
| No VICE                       | Media parsing, CPU translation and hardware services are implemented here; no external emulator dependency or fallback                                                                   |
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
| Clean scripts                 | `dev`, `build`, `build:game`, `preview`, `compile`, `check`, `test`, `test:unit`, `inspect`, `cli`                                                                                       |
| First CLI command             | `roms identify <file-or-folder> [--json]`, formats/hashes/evidence/pinned matches without executing input                                                                                |
| README usability              | Basic identify/dev/build workflow; internal recovery commands explained in `docs/CLI.md`                                                                                                 |
| Port conflict                 | Busy ports report a useful CLI error; alternate dev ports get separate output directories and watcher rebuilds are serialized                                                            |
| Deployable site               | Complete HTML/JS/CSS, verified game modules, learning material and SHA-256 media assets in `dist/site/`                                                                                  |
| GitHub repository             | https://github.com/benbruscella/romstudio                                                                                                                                                |
| Release approval              | Prepare and verify locally; **do not push v0.1 or deploy until the owner explicitly approves the reviewed result**                                                                       |

SM64 performance follow-up: broad multiply/block and coupled-scheduler prototypes were rejected after browser measurements despite correct bounded outputs. Their reports and exact source archives remain in `dist/work/`; active source keeps the simpler path. A hashed FullSync-2100 castle fixture follows original controls from the checked opening endpoint. It supports repeated fixed-work browser checks of state, RDRAM/SP and complete PCM, with renderer CPU time recorded to distinguish host contention. Device deadlines, pure DMEM transfers and guarded RSP control-wait loops are the next experiments. Full-speed acceptance remains outstanding.

The checked SM64 default is now `b163e6c9…`, with all five opening replay comparisons, 277 accounted-for unit tests and three SM64 cartridge integration tests passing. Native controls pass from a declared original-input castle fixture. The matched wide-castle production-player comparison improves from 1.02 to 1.67 FPS (about 64%); the narrower changes beyond scanlines are within native-player timing noise. A moving hillside view still shows about 4–5 FPS. PAL 25 FPS, usable real-time audio and wider progression remain unaccepted. Earlier exports/analysis are retained locally; no push/deploy authorization has been given. Prepared render-state caching matched outputs but showed no meaningful gain; it remains in private analysis and was not added to production source.
