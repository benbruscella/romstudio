# Inspiration, credits and project direction

ROM Studio's mission is to make original games playable on the web and make their engineering understandable. The projects below inform that work. Credit belongs to their maintainers and contributors; describing their published methods does not mean we have independently verified their results or integrated their code.

## ROM → TypeScript → Web

Original machine instructions become inspectable TypeScript; TypeScript compiles to JavaScript for a static browser build. The browser host presents frames, sound and controls. System services model the hardware the translated game accesses.

Native engines compiled through Emscripten/WebAssembly are outside this design. Ideas from native recompilation projects can still improve ROM Studio's TypeScript pipeline.

Readable game logic is the goal beyond instruction translation. Original-address functions are useful evidence, but meaningful routines, data structures and explanations are necessary for someone to learn how a game was written. Named interpretations must retain source mappings and checks against the original behavior.

## Contra: the original inspiration

[vermiceli/nes-contra-us](https://github.com/vermiceli/nes-contra-us) sparked the idea for ROM Studio. It provides an annotated Contra/Probotector disassembly, a build that reproduces the original ROM bytes, and supporting documentation and diagrams. Its [control-flow guide](https://github.com/vermiceli/nes-contra-us/blob/main/docs/Contra%20Control%20Flow.md) shows how to explain a game's state machine.

**What is good:** detailed study of an actual game, meaningful names and explanations that connect source to behavior. Rebuilding the original binary gives a concrete check on the reconstruction.

**What we want to adopt:** comparable depth for each completed game study: startup, memory layout, input, game states, collision, animation, graphics and sound.

**How ROM Studio differs:** our intended output includes executable TypeScript, browser play and linked learning views across systems. Our current static replay checks do not establish the byte-for-byte ROM reconstruction that Contra demonstrates. Multi-system breadth must not dilute the explanation of each game.

## RetroRecomp: reusable conversion and coverage feedback

[ArthurReboulSalze/RetroRecomp](https://github.com/ArthurReboulSalze/RetroRecomp) targets standalone Windows/Linux games using static recompilation and system-specific engines. Its [architecture](https://github.com/ArthurReboulSalze/RetroRecomp/blob/main/docs/ARCHITECTURE.md) separates conversion, compiled CPU code, hardware and the host. Its [runtime feedback](https://github.com/ArthurReboulSalze/RetroRecomp/blob/main/docs/RUNTIME_FEEDBACK.md) records execution misses to improve later builds.

**What is good:** explicit system profiles, reproducible conversion, diagnostic feedback and validation beyond a successful compilation.

**What we want to adopt:** actionable coverage reports tied to exact media, reproducible failure routes and a clear contract between translated code, hardware and presentation.

**How ROM Studio differs:** TypeScript is our executable translation and teaching medium, with the browser as the delivery target. We are not adding a native engine through Emscripten. RetroRecomp's feedback loop concerns execution coverage; ROM Studio also needs explanations for human learners. Its interpreter fallback is not ROM Studio's current policy: uncovered browser execution stops with a diagnostic.

## TMNT arcade: readable recovery with strong checks

[cheviman/tmntarcade-decomp](https://github.com/cheviman/tmntarcade-decomp) reconstructs the arcade game's 68000 and Z80 programs as C. Its README describes editable symbol metadata, functions organised by purpose, asset extraction with round-trip checks, structural checks and frame-by-frame comparisons of state, picture and sound against MAME.

**What is good:** readability is treated as a measurable engineering outcome, while code and assets retain concrete validation.

**What we want to adopt:** reproducible annotations as build inputs, named game structures, code/data classification, asset round trips and checks that cover more than the paths in a demo.

**How ROM Studio differs:** we target TypeScript and browser delivery across systems. Those deeper recovery methods are targets for our tooling, not completed features. Reviewing TMNT does not add its arcade board to ROM Studio.

## MAMEKIT: understand the machine

[benbruscella/mamekit](https://github.com/benbruscella/mamekit) compiles selected MAME C++ drivers and device descriptions into inspectable browser machine exhibits. Its source provenance, typed intermediate representations and MAME comparisons are strengths.

**MAMEKIT explains the machine; ROM Studio explains the game.**

Both target inspectable browser execution without Emscripten. The distinction is their source and subject, rather than arcade versus console:

| Project    | Starting material      | Main subject                             |
| ---------- | ---------------------- | ---------------------------------------- |
| MAMEKIT    | MAME source            | Hardware behavior, wiring and provenance |
| ROM Studio | Original game binaries | Game routines, state, data and assets    |

Shared hardware interfaces are a possible future collaboration, not an implemented dependency or a change to our current hardware models.

**A concrete compiler lesson:** inspection of the local MAMEKIT source found a source-preserving AST, a canonical typed BoardIR, schema validation at artifact loading, dependency-direction checks and generated-handler/reference comparisons. ROM Studio should apply those boundaries to binary provenance, instruction effects and control flow. Its C++ AST and machine-source compiler are not drop-in binary recovery tools. [Architecture](ARCHITECTURE.md#compiler-direction-explicit-instruction-and-control-flow-ir) records the proposed incremental IR path and distinguishes it from current string-based emission.

## arcade-decomp: bridge instruction translation and game source

[cheviman/arcade-decomp](https://github.com/cheviman/arcade-decomp) is the shared recovery tooling behind several of these game studies, including TMNT. Its documented pipeline adds data-flow analysis, signatures, pointer types and structured control flow to instruction lifting. Game profiles and symbol files supply game-specific knowledge. It also reports residual CPU/address machinery and classifies program bytes as code, data or fill.

**What is good:** it explicitly separates an instruction-translation scaffold from readable decompiled game source. That distinction exposes a real gap in ROM Studio: most executable output still consists of original-address instruction functions; only selected routines have checked named interpretations.

Its [structure checker](https://github.com/cheviman/arcade-decomp/blob/main/check_structure.py) compares basic-block graphs with structured trees using matching generated branch outcomes. This reaches functions outside recorded gameplay, but is bounded testing, not a proof of all program semantics. Its [scenario checker](https://github.com/cheviman/arcade-decomp/blob/main/check_scenarios.py) compares per-frame hashes, optional video/audio, and executed addresses against static analysis. These are complementary checks; neither replaces hardware validation.

**What we want to adopt:** a path from guarded instruction functions through control/data-flow analysis to named, structured TypeScript, with reproducible annotations, readability reports and checks at each transformation. This is a development target, not an implemented general decompiler.

**How ROM Studio differs:** TypeScript, static browser delivery and connected Play/Learn views remain our direction. MAMEKIT addresses machine-source preservation. Producing browser code alone does not put either project ahead in game-source recovery. We have reviewed these tools, not run their validation suite; there is no basis here for a universal accuracy or performance ranking.

## Further reading: cheviman's public projects

Reviewed 8 November 2026 against the [public GitHub repository list](https://api.github.com/users/cheviman/repos?per_page=100&type=owner), which returned 12 repositories. This is a portfolio survey, not an execution or compatibility audit. Descriptions below reflect the repositories' stated scope.

| Repository                                                         | Subject and useful lesson                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [arcade-decomp](https://github.com/cheviman/arcade-decomp)         | Shared recovery core; keep CPU analysis reusable and game knowledge explicit.                                                                                                              |
| [segasonic-decomp](https://github.com/cheviman/segasonic-decomp)   | SegaSonic recovery; subject-based code/assets and a faithful reference separate from ports.                                                                                                |
| [outrunners-decomp](https://github.com/cheviman/outrunners-decomp) | OutRunners recovery; explicit memory layouts and reports of remaining CPU-related constructs.                                                                                              |
| [tmntarcade-decomp](https://github.com/cheviman/tmntarcade-decomp) | TMNT recovery; editable symbols, structural checks and audio/video comparisons.                                                                                                            |
| [segasonic-port](https://github.com/cheviman/segasonic-port)       | Player-facing ports and a home adaptation above the recovered game.                                                                                                                        |
| [outrunners-port](https://github.com/cheviman/outrunners-port)     | Arcade/home variants, device controls and linked play.                                                                                                                                     |
| [tmnt-port](https://github.com/cheviman/tmnt-port)                 | Arcade/home variants and multiplayer built above TMNT's recovery.                                                                                                                          |
| [arcade-lan](https://github.com/cheviman/arcade-lan)               | Separate lockstep and linked-cabinet networking contracts; deterministic input is useful infrastructure.                                                                                   |
| [htmlsaturn](https://github.com/cheviman/htmlsaturn)               | Browser JavaScript emulator, chip modules, worker rendering and audio output. Closest to our browser execution concerns, though it interprets game code rather than recovering TypeScript. |
| [robotech-decomp](https://github.com/cheviman/robotech-decomp)     | Xbox recompilation, gradual structured recovery and host API bridges; scope extends beyond arcade boards.                                                                                  |
| [simpsons-decomp](https://github.com/cheviman/simpsons-decomp)     | Announced Simpsons recovery; the repository was empty at review, so its description is not evidence of an implementation.                                                                  |
| [.github](https://github.com/cheviman/.github)                     | Shared funding configuration; not another game or recovery engine.                                                                                                                         |

The recurring separation between reusable tools, faithful recovery and player-facing adaptations is useful for ROM Studio. Keep experimental modifications separate from original behavior and its verification. ROM Studio can use folders and explicit contracts for these boundaries; this survey does not require splitting our repository.

HTMLSATURN also describes controlled performance measurements and hash-preserving optimizations. Its reported idle health sweep does not by itself establish complete gameplay or hardware fidelity. Its plain JavaScript delivery reinforces why browser execution alone is insufficient differentiation: ROM Studio also needs understandable recovered game logic and useful learning tools. Multiplayer, Saturn, Xbox and additional arcade games remain inspiration, not additions to v0.1.

## Apply the ideas without losing focus

These references guide improvements to ROM Studio; they do not replace its direction or expand the release by themselves. Arcade games fit the architecture, but each board still needs supported processors, memory mapping, video, audio and timing. Committed v0.1 scope is six excellent C64, NES and N64 games plus the ROM Desk workbench, recorded in [Releases](RELEASES.md); [Project status](PROJECT-STATUS.md) tracks the evidence. NES sound takes priority over further SM64 browser-play work.

| Improvement                                              | Current position                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Exact media identity and reproducible routes             | Implemented for registered studies                                                     |
| Assembly → generated TypeScript links                    | Implemented with documented observation limits                                         |
| Named, checked game routines                             | Selected routines; coverage remains partial                                            |
| State, picture and sound replay                          | Bounded state/picture/SID checks; NES per-frame PCM replay and browser output verified |
| Rich symbols/types driving readable regeneration         | Goal; current recipes and interpretations are a starting point                         |
| Complete code/data/fill accounting and structural checks | Goal; not a general implemented capability                                             |
| Editable assets with byte-for-byte round trips           | Goal; not a general implemented capability                                             |
| Independent whole-machine accuracy                       | Unverified; internal replay alone cannot establish it                                  |

Use ideas with attribution. If implementation code is reused in future, record the exact origin and applicable licence with it; a reference link alone is not code provenance. Original authors' symbols, our interpretations and unresolved hypotheses must remain distinguishable.

## Educational acceptance for a completed study

1. Pin source media and reproduce the build, declaring fixtures and annotations.
2. Link assembly and TypeScript to original bytes, addresses, banks and memory epochs.
3. Explain startup, the main loop, input, game states and important memory structures.
4. Document gameplay, collision, graphics, animation, sound, loading and progression.
5. Check named interpretations against original instructions and explain uncertain names or hypotheses.
6. Exercise normal play and failure regressions with recorded inputs, state, picture and sound evidence.
7. Keep generated game code, explanatory interpretations, hardware models and browser code visibly separate.

The current partial studies have not met this full standard. Use **Play Game** to experience accepted behavior and **Learn** to trace it to the original code. See the [architecture](ARCHITECTURE.md) for implementation boundaries and [contribution guide](../CONTRIBUTING.md) for adding evidence.
