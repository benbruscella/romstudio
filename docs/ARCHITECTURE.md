# Architecture: bytes, game code, hardware, browser

ROM Studio has two outcomes: a playable static game and an explanation of how its original code works. A reusable converter alone does not satisfy the educational goal.

The agreed path is **ROM → TypeScript → Web**, with TypeScript compiled to JavaScript for delivery. The one excluded technology is Emscripten: ROM Studio does not ship a native engine compiled for the browser. WebAssembly, GPU drawing and high-level microcode implementations are permitted in the [play tier](#execution-tiers) when measurements justify them. [Inspiration and credits](INSPIRATION.md) records the projects informing the work and the distinction from MAMEKIT: it studies machine behavior from MAME source, while ROM Studio studies game behavior from original binaries. A shared hardware interface is a future possibility, not a current dependency.

## The boundaries

| Layer               | Source                                    | Responsibility                                                                                          |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Original media      | `roms/`                                   | Immutable disk images, cartridges or chip dumps, pinned by SHA-256                                      |
| Media readers       | `src/media/`                              | File chains, load addresses, headers and chip extraction                                                |
| Transpiler          | `src/transpiler/`                         | Decode assembly, recover executed variants, follow known control flow and emit source-address functions |
| CPU runtime         | `src/runtime/`                            | Registers, arithmetic, bus operations and the shared frame clock                                        |
| System hardware     | `src/systems/<system>/`                   | Memory mapping, video, input, interrupts and sound devices                                              |
| Game study          | `src/games/<system>/<game>/`              | Recipe, release/loader knowledge, recovery scenarios, named interpretations and documentation           |
| Browser application | `src/web/`                                | Navigation, controls, layout, canvas presentation and audio output                                      |
| Node tooling        | `src/cli/`, `src/analysis/`, `src/build/` | Identification, isolated analysis, verification and static packaging                                    |

## Three kinds of game-related code

**Original assembly translated mechanically:** `dist/work/games/<system>/<game>/game-code/program.ts` and `.js`, with address pages for larger programs. Functions retain original source addresses and guarded instructions. Some reviewed 6502 exports guard the opcode and read mutable operands from RAM; other exports guard exact bytes or instruction words. The manifest declares that choice. This is executable recovered game code, not web UI or a high-level explanation. No decoder or dynamic compiler is shipped in the browser.

**Named interpretations:** `src/games/<system>/<game>/code/`. These explain a recovered routine using meaningful names and comments tied to addresses. The names are ours, not recovered author symbols. Lemmings' digger is compared with the original handler in a separate memory copy. An interpretation is not silently substituted for the original game.

**Browser adapters:** `src/games/<system>/<game>/web/title.ts` and the shared shell. These describe controls, labels, learning links and display geometry. They do not move game characters, invent level terrain, or implement game rules.

## Execution tiers

Playing at full speed and explaining exactly are separate jobs, decided on 9 November 2026 ([RELEASES.md](RELEASES.md#execution-tiers--decided-9-november-2026)). The **reference tier** executes every processor's original instructions one functional step at a time. It is the verification baseline and the execution behind Learn and ROM Desk, and it may run below full speed. The **play tier** runs the same recovered game code with faster implementations of the system work beneath it. It powers Play Game.

| Layer                 | Reference tier                                     | Play tier                                                                                                |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Game CPU code         | Recovered static functions, one instruction a step | The same recovered code; may be compiled into larger guarded blocks                                      |
| Named interpretations | Explained in Learn and compared with the original  | Never substituted for the original                                                                       |
| N64 RSP microcode     | Original RSP instructions                          | High-level implementation of recognized microcode; unrecognized microcode runs its original instructions |
| N64 RDP drawing       | Software renderer writing RDRAM synchronously      | Software renderer, a parallel worker or GPU drawing, within a declared picture tolerance                 |
| Device scheduling     | Per-tick references                                | Event deadlines and batching                                                                             |
| Used by               | Verification, Learn, ROM Desk                      | Play Game                                                                                                |

C64 and NES currently use one path for both tiers. A play-tier implementation of system microcode is a fourth kind of code alongside the three above: ROM Studio's TypeScript account of documented library behavior, such as Fast3D display-list commands. It lives with the system under `src/systems/<system>/`, keyed by the exact microcode bytes it recognizes, and is labelled as our implementation rather than recovered original code. It never encodes game rules.

The tiers exchange state only at declared boundaries. For N64 the boundary is between RSP tasks, when CPU, RDRAM and device state agree. Opening ROM Desk from Play transfers state to the reference tier there. Play-tier acceptance replays recorded input routes on both tiers and compares game state at frame boundaries, PCM where the implementation permits it, and pictures within a declared tolerance. Tick-identical machine hashes remain the reference tier's own original/static acceptance.

## Shared execution, distinct machines

Game implementations are grouped by platform: `src/games/c64/lemmings/`, `src/games/nes/tetris/` and `src/games/n64/sm64/`. Reusable machine hardware stays in `src/systems/<system>/`. A port has its own original program, media, recovery evidence and explanations, so it does not live inside the hardware implementation or share an executable game identity with another port.

The canonical game key is **`<system>/<game>`**. Source discovery, the registry, recovery outputs, learning JSON, media-bundle identities and browser routes preserve that pair. For example, future `c64/tetris` and current `nes/tetris` can coexist without overwriting files. Short CLI aliases are accepted only when unique; `--system` can disambiguate them. A shared display name or future cross-port comparison page is metadata, not shared original game code.

C64 and NES share the 6502 instruction backend and pacing support. Their buses are separate. The C64 has banking, VIC-II, CIA and SID; the NES has cartridge boards, PPU, serial controllers, OAM DMA and a PAL 2A07 APU. The [APU](systems/nes/AUDIO.md) models the five voices, frame/DMC IRQs and sample DMA; host-rate PCM sampling is an observer of that hardware. Muting must preserve machine execution. The NES CPU disables decimal arithmetic while retaining the D flag. That difference belongs to CPU/system configuration, not a game-specific patch.

N64 uses a separate VR4300/MIPS backend with 64-bit integer registers, delay slots, system control and floating-point state. Its machine models CPU-visible RDRAM, cartridge, PI/SI DMA, interrupts, controller/EEPROM protocol, VI registers, AI PCM FIFO and SP memory/DMA. The RSP scalar/vector backend executes original microcode; RDP packet decoding, rasterization, texture sampling and color/depth processing are separate hardware services. Bounded CPU, audio, clear, texture and rendered-task studies have static replay evidence. A later title-to-opening replay also completed for its captured source fingerprint; it is separate from current browser validation. Pixel precision remains approximate. See [CPU](../src/games/n64/sm64/docs/CPU.md), [graphics](../src/games/n64/sm64/docs/GRAPHICS.md) and [current acceptance](PROJECT-STATUS.md). This machine is the N64 reference tier; the first SM64 play tier (high-level Fast3D graphics tasks and a parallel RDP worker) runs on top of it, as described under [Execution tiers](#execution-tiers).

The RSP compiler also emits bounded execution metadata for safe local operations and branches. The N64 scheduler can use it while the CPU waits, strictly before the next observable event. Specific status reads require an explicit system guarantee; device writes, semaphore reads and faulting operations stay on the ordinary path. Instruction guards and the single-step path remain available. This optimization is separate from the proposed general semantic IR below. [Performance](../src/games/n64/sm64/docs/PERFORMANCE.md) records its invariants and evidence.

Play mode can defer otherwise idle device calls until an event or MMIO/snapshot observation, keeping CPU Count and RSP phase current. Guarded status-wait iterations and pure DMEM halfword transfers preserve the ordinary stepping/byte-transfer references. These are targeted functional-model optimizations, with current replay evidence in the game performance chapter.

The N64 software renderer consumes reusable scanline buffers. Draw packets prepare color/depth state, resolve combiner selectors to scratch-register indices and choose packed texture fetchers. Scalar tuple-based APIs remain numerical references. Both paths write original RDRAM synchronously and retain the documented functional precision. Broader arithmetic/block prototypes were removed after disappointing browser results; they do not replace the proposed general semantic IR or the ordinary stepping contract.

Hardware execution also uses shared 32/64-bit register views, guarded single-precision math, alias-aware vector reads and scanline/texture sampling optimizations. These preserve original instruction and device boundaries. The exact arithmetic reference, scalar rendering comparisons and ordinary stepping paths remain available; none substitutes Mario rules or changes the cartridge's clocks.

The C64/NES host uses the shared shell. An N64 player and worker host exist under `src/systems/n64/`, with game prose under `src/games/n64/sm64/web/`. The checked local package has reached original menus, Mario movement, jumping, kicks and punches. A later hillside profile measured 4.75 completed graphics tasks per second, still below playable acceptance. [Performance evidence](../src/games/n64/sm64/docs/PERFORMANCE.md) distinguishes title comparisons and live controls. Usable sound, full-speed sustained gameplay and wider progression remain unfinished. Reference-tier optimization has reached diminishing returns, so full-speed SM64 depends on the play tier. Browser presentation stays separate from original CPU/RSP execution and hardware models in both hosts.

Browser input is a neutral set of pressed controls. The selected system converts that to CIA pins, NES controller bits or N64 buttons/stick values. System-specific input logs are sampled at original game polling points. A system profile supplies display size and frame timing; the web shell does not import C64 hardware.

Node analysis can compile recovered instructions while exploring a trace. Static browser output contains only emitted functions and execution support. Per-route child processes isolate analysis heaps; a crash or failed comparison fails the build. Baseline V8 settings are being checked on this host because optimized analysis has crashed natively. This is not a correctness fallback.

## Verification and honesty

Original instruction recovery and exported static replay must agree on CPU state, RAM, devices, recorded input and capture-enabled pixels/audio. Independent synthetic tests check hardware rules and arithmetic. Comparing two executions of our own hardware model establishes internal consistency, not independent hardware accuracy. A play tier is checked against the reference tier on recorded routes; that comparison establishes agreement between our two tiers, not hardware accuracy for either.

C64 unknown RAM stays unknown unless loaded, written or explicitly seeded. NES launch RAM fill is an explicit fixture. Startup services and reviewed release shortcuts retain byte guards, preconditions, source addresses and limitations. Unrecovered execution stops with a diagnostic rather than becoming invented game behavior.

N64 startup declares its post-IPL3 memory/register fixture and functional instruction clock. The isolated SM64 entry has an independent named interpretation with nonzero initial state. Longer startup and paused-CPU audio/graphics fixtures have separate original/static comparisons. Their supplying CPU captures remain distinct from the later title-to-opening replay. Each report describes its own launch, source fingerprint and stopping boundary; none establishes a console-reset path, hardware timing or ordinary browser gameplay.

## Workbench boundary

ROM Desk is required for v0.1. The browser workbench presents source, registers, memory and system diagrams; a system debug adapter controls the reference tier, which runs the same recovered game code as Play. Entering Desk from Play transfers state at a declared tier boundary. Run/pause/restart, instruction/frame steps and address breakpoints must preserve actual device state and identify the active processor/address space. Paused inspection must not change machine state. Source views and checkpoints exist; this shared debugger contract and UI remain unfinished. [RELEASES.md](RELEASES.md) defines acceptance, while advanced exploration stays in Blue sky.

## Compiler direction: explicit instruction and control-flow IR

An abstract syntax tree (AST) represents source-language structure; an intermediate representation (IR) records the program facts and operations that analysis and code generation need. Our input is a binary, so a source-language AST is not the first missing layer. Current decoded `Instruction` and `Vr4300Instruction` records already provide a small instruction representation. Most executable lowering still builds JavaScript/TypeScript strings, and observation data is assembled separately. There is no general semantic/block IR or structured game decompiler yet.

The local MAMEKIT implementation supplies a useful pattern: its [source-preserving AST](https://github.com/benbruscella/mamekit/blob/main/src/mame/ast.ts) retains C++ spans; [BoardIR](https://github.com/benbruscella/mamekit/blob/main/src/ir/board.ts) is a typed compiler/execution contract; [artifact decoding](https://github.com/benbruscella/mamekit/blob/main/src/ir/decode.ts) rejects malformed or stale schemas; and [code-generation tests](https://github.com/benbruscella/mamekit/blob/main/src/mame/board-codegen.spec.ts) compare generated handlers with reference execution. These are inspected implementation patterns, not a claim that we ran MAMEKIT's tests or share its runtime.

ROM Studio should grow its own small IR incrementally:

```text
Original bytes + explicit launch/mapping state
  → decoded instructions + binary provenance
  → typed instruction effects + basic blocks/control-flow edges
  → guarded TypeScript + source maps
  → JavaScript for Play and ROM Desk
```

The same records should supply assembly views, coverage and source correlation. The IR must not depend on browser APIs, Node tools, a particular game or generated source text. CPU-specific semantics remain explicit: 6502 status flags, NES decimal configuration, MIPS widths/exceptions/delay slots and RSP vector lanes cannot be flattened into ordinary JavaScript arithmetic without preserving their rules.

| Information to retain                                                                         | Purpose                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Processor/address space, address, exact bytes/word, media offset and observed mapping/variant | Distinguish different code at the same address and link behavior back to original bytes          |
| Register and memory effects, widths, signedness, flags, traps and ordered bus operations      | Make transformations inspectable without changing machine behavior                               |
| Instruction boundaries, timing, delay slots and event/interrupt barriers                      | Preserve stepping and device interactions; identify where batching is permitted                  |
| Direct/indirect control-flow edges, unresolved targets and observation evidence               | Explain known routines while retaining gaps and separating observed code from coverage envelopes |
| Annotations and their evidence                                                                | Keep human names/types distinct from recovered author symbols and from executable facts          |

A block IR can support data-flow analysis and later structured routines. A structured AST of expressions, loops and named calls belongs at that higher layer. A TypeScript AST printer may also improve emission, but it does not supply missing game semantics by itself. Neither representation automatically solves missing execution coverage, audio accuracy or SM64 performance.

Adopt one backend through an unchanged-output pass first, then check its generated execution against the existing instruction path, device state and input/pixel/PCM fixtures. Every optimization must preserve that evidence and remain observable at original instruction boundaries; debugger stepping must bypass batching where needed. Keep reference evaluation in analysis/tests and ship static generated code to Play. Version and validate serialized IR at its boundary, and report unsupported constructs with binary provenance. General SSA, a large universal instruction language and a replacement MAME hardware compiler are not prerequisites for this first step.

## Files and outputs

Each game owns `recipe.json`, `recovery/`, `code/` where meaningful, `web/`, colocated tests, `README.md` and `docs/`. Shared documentation stays in `docs/`. `*.integration.test.ts` requires original local media; synthetic unit tests do not. The test runner discovers current source tests, so stale compiled test files do not reappear in runs.

Everything generated goes under `dist/`: `tools/` for compiled tools, `work/` for recovery evidence and game packages, and `site/` for deployment. Only verified declared game files, learning material and explicitly included hashed media enter the site. Recovery scratch files and test/browser profiles remain in work.

SM64's bounded boot commands write their read-only source packages under `analysis/startup/source-study/`. The browser builder uses the game package directory separately. Running a boot study must not overwrite an executable package or silently certify newer source using an older cache.

## Assembly and TypeScript explorer

Each game package includes `game-code/observed-source.json`. It retains the first observed byte variant for each source address/opcode and links it to the emitted `at_<address>_<opcode>` function. Learn's code explorer shows both without executing source text. The full analysis traces retain additional variants and provenance in dist/work. The browser sample is not a complete bank/epoch reconstruction, and generated instruction code remains distinct from named interpretations.
