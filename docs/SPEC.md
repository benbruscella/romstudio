# ROM Studio specification

**Status** Experimental C64/NES slices and bounded N64 CPU/RSP/audio/graphics studies; v0.1 is unfinished · **Targets** C64 Lemmings, Nebulus and Elite; NES Super Mario Bros. and Tetris; N64 Super Mario 64 · **Output** Standalone HTML, CSS and JavaScript built from TypeScript

## Product goal

ROM Studio converts game media into working browser games. Give it a ROM, cartridge dump, disk set or other game image and a target system. ROM Studio identifies the media, recovers the machine instructions for that system, lifts the game code into an executable representation, and builds a web app with the controls and presentation appropriate to the system.

The agreed delivery path is **ROM → TypeScript → Web**. TypeScript compiles to browser JavaScript; Emscripten is the one excluded technology. Understandable game code and connected Play/Learn/Desk views are core goals. Play may use a faster [play tier](ARCHITECTURE.md#execution-tiers); Learn and ROM Desk use the exact reference tier, and the two are checked against each other on recorded routes. [Inspiration and credits](INSPIRATION.md) explains the engineering ideas we want to adopt and how ROM Studio differs from the reference projects.

Any system is in scope for the architecture. A system becomes supported once ROM Studio has an adapter that understands its media, CPUs, memory maps, peripherals and timing. A supported system can still contain titles that expose hardware features or code paths the adapter has yet to cover. ROM Studio reports those gaps at the title and build level.

ROM Studio studies game code from original binaries. MAMEKIT studies machine behavior from MAME source. ROM Studio currently implements its media parsing, instruction decoding, lifting and system services from scratch, without an external emulator backend or fallback. Validate against original bytes, documented hardware behavior and independent deterministic fixtures. Record the origin of reference evidence and distinguish internal consistency from hardware parity. A shared hardware interface remains a future proposal, not an implemented dependency.

## Educational acceptance

The inspiration is [vermiceli/nes-contra-us](https://github.com/vermiceli/nes-contra-us). A completed game study must offer comparable depth: annotated assembly, meaningful routine names, source/bank mappings, memory maps, control-flow explanations, graphics and sound chapters, and reproducible evidence. [The educational standard](INSPIRATION.md) defines this separately from playable coverage. ROM Studio adds multi-system infrastructure, readable checked TypeScript interpretations and linked Play Game/Learn views. The current partial slices do not yet meet the full standard.

## Intended user workflow

Identification, curated game recipes and bounded static exports exist today. The ROM Desk workbench, including identifying supported media, is required for v0.1 and is implemented ([DESK.md](DESK.md)). Automatic complete recovery of arbitrary binaries is a longer-term goal. [RELEASES.md](RELEASES.md) is the committed scope and decision record.

1. Import one or more related media images. ROM Studio fingerprints them and proposes a system and format. The operator can override detection, order disks, identify the boot medium and provide firmware when required.
2. Analyse the title. ROM Studio extracts files and banks, disassembles reachable code, records address and media provenance, and captures execution where static analysis leaves gaps.
3. Build the title. ROM Studio lifts verified routines into TypeScript, packages required assets and state, and binds them to the selected system's browser profile.
4. Verify and export. ROM Studio compares a scripted run against a reference, reports unsupported paths, and exports a static web bundle with an index page, runtime code, assets and a manifest.

## Conversion pipeline

| Stage          | Responsibilities                                                                                                                                                                     | Output                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Identify       | Hash media, inspect headers and geometry, detect candidate systems, and record disk order and firmware requirements. Treat media as untrusted input and bound parsing and execution. | Input manifest and detection evidence                         |
| Load           | Map cartridge banks, extract disk files, reproduce boot or load commands, and track writes that unpack or relocate code.                                                             | Address-space model, media inventory and memory images        |
| Disassemble    | Decode using the correct ISA variant. Seed from vectors, entry points and observed execution. Follow control flow and track code, data, bank and memory epoch separately.            | Annotated assembly, control-flow graph and unresolved targets |
| Lift           | Model registers, flags, operand widths, memory effects, interrupts and timing where observable. Lift verified code into an intermediate representation and generate TypeScript.      | Executable routines with source address mappings              |
| Recover assets | Identify decoded levels, sprites, maps and audio data. Preserve original bytes and access semantics where a higher-level format is still unknown.                                    | Asset manifest and reproducible extraction rules              |
| Package        | Link translated routines with the minimal system services they use. Bundle the browser shell and system profile.                                                                     | Static browser application                                    |
| Verify         | Replay recorded inputs against reference and browser builds. Compare checkpoints, timing, screen output and meaningful game state.                                                   | Build status, parity report and coverage gaps                 |

### Translation strategy

Start with instruction-accurate lifting for reachable routines. Raise a routine to readable game logic when its inputs, outputs, side effects and timing can be checked against the original. For example, a verified collision routine can become a named TypeScript function backed by the recovered terrain format. Preserve source mappings so a mismatch can be traced to the original bank and address.

Use trace-guided recovery for indirect jumps, overlays, bank switches and self-modifying code. Tie a translated block to the mapped bytes that produced it and invalidate it if those bytes change. Treat traces as observed coverage and retain unresolved targets in the report. ROM Studio should support reviewed per-title annotations and patches as reproducible build inputs.

A translated build uses shared system services for video, sound, input and timing. ROM Studio has no external emulator backend or fallback. A build with unresolved execution on a required play path is partial. An unknown format or missing adapter yields a diagnostic that identifies the missing capability.

## Adapter design

| Component      | Contract                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Media reader   | Probe a byte stream, validate geometry, extract entries or banks, and expose stable source offsets. A format can be shared across systems.                                           |
| CPU backend    | Decode and lift instructions for a specific ISA variant, including operand widths, flags, interrupts and timing effects. A backend can be shared across systems.                     |
| System adapter | Define address spaces, bank and overlay rules, devices, firmware policy, boot procedure, trace hooks and browser system services. Support multiple execution domains where required. |
| Title recipe   | Pin source hashes, media order, launch settings, entry points, data annotations and deterministic verification inputs. Keep title-specific knowledge here.                           |
| Web profile    | Define display geometry and scaling, controls, media actions, and save capabilities exposed by the common UI.                                                                        |

Use system and title adapters at these boundaries so a new machine can reuse existing CPU or media backends. This is a source-level design, not a shipped third-party plugin loader. NES provides the second-system check with a shared ISA and different devices. N64 introduces a different ISA and multiple processors; a CPU startup study is an intermediate milestone, not a complete system adapter.

Title modules live in `src/games/<system>/<game>/` for all six targets. Each folder owns the boot hooks, recovery/build scenarios, explanations and browser adapter it currently implements. Do not create empty player/web folders for a source-only study. Shared launch options and project paths live in `src/startup.ts` and `src/paths.ts`; neither depends on a game module. See [the source layout](ARCHITECTURE.md).

## Browser application

The browser product uses a common library and consistent controls: game viewport, reset, pause, audio, fullscreen and help. System execution adapters may use different hosts; the N64 worker host is still in progress. Offer save/resume only after that title's state restoration is validated. System profiles supply aspect ratio, input mapping and media capabilities. Disk switching, port selection and a general browser import flow are goals rather than controls implemented in every current study.

Drive game logic from a deterministic system clock. Render on the browser frame clock and let the audio service consume scheduled events or samples. Allow an input log to replay against a named build and timing profile. A production bundle should run from a static host without a server-side emulator. The export manifest records any user-supplied media or firmware needed to launch.

## Workbench acceptance

ROM Desk is required alongside all six games. Its core includes supported-media loading/identification, real execution controls and instruction/frame stepping, synchronized assembly/TypeScript, register/memory inspection, address breakpoints and basic system diagrams. It must operate through system adapters on the reference tier, with source/bank/epoch identity, and preserve static browser execution. Desk may run below full speed. See [the release contract](RELEASES.md) for the full baseline and [Testing](TESTING.md) for acceptance. Existing Learn views do not by themselves complete a debugger.

## Trial 001 · Commodore 64 Lemmings

### Inputs

Use the attached Alpha Flight release. The supplied notes identify the 1994 Psygnosis title, Thomas Mittelmeyer as programmer, Jeroen Tel as musician, joystick port 2, and three disks. Start with trainers disabled and use PAL as the initial reference timing profile. Keep the other timing profile and trainer paths outside the first parity run.

| File           | Role                                                                        | SHA-256                                                            |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `LEMMING0.D64` | First trial disk and boot medium. Contains `LEMMINGS+` and `LEMMINGS DOCS`. | `0bf8fdde3c715154354624c034571d974f8f65d7a508e0a540a48dc962f91f44` |
| `LEMMING1.D64` | Second disk. Determine file roles from loader traces.                       | `8607c8830c36621219f624f44c2f2663c96571429d4439283d297c2ddf3656b8` |
| `LEMMING2.D64` | Third disk. Verify its content and disk changes during the full trial.      | `2410d41f10ee8a7d2b5c636852f63be79cb95309077dd323e95c649f03cc7d7d` |
| `VERSION.NFO`  | Release metadata and controls reference.                                    |                                                                    |

### Verified bootstrap bytes

`LEMMINGS+` has a PRG load address of `$0801`. The BASIC line contains `9E FF AC 36 35 36`, which decodes as `SYS π*656`. BASIC's integer conversion gives the expected entry address `$080C`. The static decode below shows a 256-byte copy into RAM at `$0340` and a jump to it. Verify this handoff using the original bytes and independently specified CPU tests before following the relocated code. Earlier discussion gave `$0812` as the entry. It is an instruction inside the bootstrap.

```asm
080C  A0 00     LDY #$00
080E  78        SEI
080F  EE 30 D0  INC $D030
0812  4E 11 D0  LSR $D011
0815  E6 01     INC $01
0817  B9 31 41  LDA $4131,Y
081A  99 40 03  STA $0340,Y
081D  C8        INY
081E  D0 F7     BNE $0817
0820  4C 40 03  JMP $0340
```

The disk inventories include recurring `SA` through `SI` filenames and other two-letter groups. Record the actual read order, decoded destinations and resulting bytes before assigning meanings to those files.

### Milestones and acceptance

| Milestone                                      | Acceptance                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Reproduce the boot**                      | Parse the three D64 directories and sector chains. Extract `LEMMINGS+`, reproduce its load address and bootstrap listing, and verify the handoff to `$0340` in ROM Studio. Follow execution to the menu and identify newly written executable regions.                                                                                                          |
| **2. Recover the first level**                 | Capture the reads and RAM state that construct the first playable level. Identify terrain and collision data, spawn and exit coordinates, and level parameters. Decode a second level to test the data model.                                                                                                                                                   |
| **3. Ship the first translated browser slice** | Build a static HTML game from the recovered data and lifted TypeScript routines. Start the first level with the C64 UI profile, move the cursor, assign at least one skill and complete the level. Replay a reference input sequence and compare spawn timing, lemming state, terrain changes and the completion result. Report incomplete routines explicitly. |
| **4. Complete the trial title**                | Run normal gameplay across the three-disk set. Verify all gameplay skills, progression, disk transitions and representative audiovisual output. Record intentional differences and any remaining gaps in the parity report.                                                                                                                                     |

Current checkpoint: `npm run cli -- build-game lemmings` exports a playable static first-level slice, and `npm run cli -- play --title lemmings` serves it locally. A recorded route assigns a digger, rescues six lemmings and uses the original nuke control to end two trapped lemmings. The static replay matches the recovered execution's CPU, RAM, device state, raster pixels and completion counters. The reviewed source-address lowering guards recovered opcodes while reading mutable operands as data; unknown shapes stop explicitly. See [the browser chapter](../src/games/c64/lemmings/docs/BROWSER.md) for acceptance and limitations. The original result screen, progression, wider gameplay coverage, exact SID sound and independent hardware parity remain outstanding.

## Trial 002 · Commodore 64 Nebulus / Tower Toppler

The supplied NFI US release in `roms/c64/nebulus/` is pinned by [its recipe](../src/games/c64/nebulus/recipe.json). `npm run cli -- boot --title nebulus` boots the original `TOWER TOPPLER+` PRG, leaves the release screens with recorded inputs, loads `TOWER1` through a shared functional KERNAL LOAD service, executes the original game initialization and captures the menu input loop. A static startup replay must match recovered CPU, RAM, devices, pixels and inputs. This is a second title using the shared C64/CPU/media components, rather than the Lemmings-specific bootstrap fixture.

`npm run cli -- build-game nebulus` exports the original title screen and first-tower instructions. **Play game** enables the opening music and waits for **Space** or Fire; native instructions then initialize gameplay. Bounded routes cover walking, firing, delayed jumps, doors/lift directions, rapid reversals, life loss, movement-to-Up, and Right → tunnel → Left → next Up. The latter reaches `$9220` through a mutable call target. Every route must replay with matching CPU/RAM/device state and inputs; the example, tunnel and sound regressions also compare raster pixels and SID samples. The builder separately checks that idle title input keeps waiting with audible music, and fire starts the original game. The recorded example exercises controls and does not claim tower completion. `npm run cli -- play --title nebulus` serves the local export on port 4174.

Static reachability follows direct branches/calls through known game RAM at `$8000–$FFFF`, including drawing helpers in `$C000` and the SID driver at `$F000`. Unknown bytes and unresolved indirect targets remain gaps. Horizontal fine scrolling follows the original `$D016` setting; it shifts graphics and the foreground mask while preserving sprite coordinates. This corrects a four-pixel doorway offset without moving Pogo in game state.

The title enables two reviewed NMOS NOP extensions and declares its launch workspace, screen-tail fixture and padding-preserving XOR relocation. Its timer requires decimal ADC/SBC support in the shared CPU backend. The C64 titles use a common player, input protocol, static compiler, browser shell and packager, with title-specific boundaries and state interpretation. See [the shared architecture](ARCHITECTURE.md), [startup](../src/games/c64/nebulus/docs/BOOT.md) and [gameplay](../src/games/c64/nebulus/docs/GAMEPLAY.md). Shared approximate SID synthesis follows original register writes at 1× speed. Tower completion, later towers, trainer defaults, exact sound and independent hardware parity remain unverified.

## Additional v0.1 studies

[Elite](../src/games/c64/elite/README.md) uses the shared C64 services to recover the original new-commander, docked status, launch and bounded flight/view paths. Its documented unpacker annotation and functional KERNAL text services remain explicit assumptions.

[NES](systems/nes/README.md) uses the same 6502 translation with binary arithmetic and separate NROM/MMC1, PPU, DMA, controller and PAL clock services. [SMB](../src/games/nes/smb/README.md) covers startup and first-world controls. [Tetris](../src/games/nes/tetris/README.md) covers startup, menus and bounded piece controls, with a named interpretation checked against the original two-pass input filter. The [PAL APU](systems/nes/AUDIO.md) follows original register writes for pulse, triangle, noise and DMC output, including IRQs and DMC reads/stalls. Acceptance requires original/static state and per-video-frame PCM replay plus live browser review; [current status](PROJECT-STATUS.md) records completed checks. Full progression and independent hardware parity remain separate requirements.

[Super Mario 64 — Europe](../src/games/n64/sm64/README.md) is the sixth required v0.1 game. Its byte-swapped original is pinned separately from the normalized cartridge identity. Bounded CPU startup, RSP audio, clear, texture and rendered-task studies have static replay evidence. A later captured title-to-opening route also completed static CPU/RSP replay for its recorded source fingerprint. The worker player is in progress; browser performance, live controls, audible music, saves and progression remain unverified. NES sound takes priority over further SM64 browser work. v0.1 requires all six games working; excluding or relabelling unfinished execution does not complete that objective.

## Implementation boundaries

- Preserve original media by hash and keep input images, firmware and extracted commercial assets out of the source repository. Define separately which assets may be included in a public export.
- Make each stage rerunnable from its inputs. Cache by media hash, adapter version, recipe version and timing profile.
- Require both a build result and a verification result. A successful bundle proves it builds. A reference replay provides evidence for the particular paths checked.
- Keep lifting and rendering independent. The same translated routines should run in a headless verification harness and in the browser.

## References

- [Commodore 64 BASIC SYS routine](https://skoolkid.github.io/sk6502/c64rom/asm/E12A.html) for expression evaluation and integer address conversion.
- [Commodore 64 BASIC π token](https://www.c64-wiki.com/wiki/Pi) for the bootstrap expression.

## Library, CLI and deployment acceptance

The first command is `roms identify <file-or-folder> [--json]`. Recognition reports evidence and hashes without executing input. The main user workflow is identify, dev, build; advanced recovery stays in [CLI.md](CLI.md).

The release library selects system, game, then Play Game, Desk or Learn; `/desk` identifies original media. History URLs support direct load, refresh and Back/Forward. One compact navigation row precedes the game viewport; duplicate branding, huge headings and redundant score panels must not consume laptop/desktop play space. The same build works at a domain root or a project folder such as `/romstudio/`.

All generated outputs belong in `dist/tools/`, `dist/work/` and `dist/site/`. The final directory includes HTML/JS/CSS, verified game modules, learning material and SHA-256-addressed media. Game-specific documentation and recipes live with source in `src/games/<system>/<game>/`. Tests are colocated. See [architecture](ARCHITECTURE.md), [build](BUILD.md) and [contributing](../CONTRIBUTING.md).

The repository is https://github.com/benbruscella/romstudio. [Project status](PROJECT-STATUS.md) retains the decisions and outstanding acceptance work.
