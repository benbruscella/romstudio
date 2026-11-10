# ROM Desk

ROM Desk is the workbench in v0.1 ([scope](RELEASES.md#rom-desk-workbench--required-for-v01)). It pauses the actual translated game, steps it, and shows the original instruction, its generated TypeScript, registers, flags and memory at the same paused machine point. It runs on the **reference tier** ([execution tiers](ARCHITECTURE.md#execution-tiers)) and may run below full speed.

## Routes and navigation

| Route                     | View                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `/<system>/<game>`        | Play                                                                 |
| `/<system>/<game>/desk`   | Desk: the same game page with the workbench open                     |
| `/<system>/<game>/learn…` | Learn chapters and code explorers                                    |
| `/desk`                   | Identify original media by SHA-256 and open the matching game's Desk |

Play and Desk share one embedded game page. Switching between them for the same game sends a message to that page instead of reloading it, so **opening Desk from Play keeps the running game**. A direct `/desk` link starts the game from its launch checkpoint, paused before its first frame. While Desk is open, the page's own Pause button is disabled and game keys go nowhere. Desk is reachable from the Play/Learn tabs and by history URL, and its layout stacks on narrow screens.

## The paused machine point

Desk acts only on the real system adapter and the game's static translated functions. It adds no browser decoder and no dynamic compiler. When the program has no function for an instruction, Desk reports the recovery gap, just as Play does.

| System  | Unit of an instruction step                                                                                                     | Frame step                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| C64/NES | One iteration of the shared frame clock: a boundary service (interrupt, input poll) or one translated 6502 instruction          | Run to the frame deadline   |
| N64     | One functional machine tick: one VR4300 instruction plus any RSP instruction due at the 2:3 clock phase. Desk reports which ran | Run to the next VI FullSync |

On the N64 there are separate **Step CPU** and **Step RSP** controls. Step RSP runs ticks until the RSP retires an instruction. If the RSP is halted, it first runs the CPU until it starts the next RSP task, and reports how many ticks that took. When a step enters an interrupt or exception, the status line says so. Desk never uses the idle-loop or batched RSP shortcuts while stepping. Those shortcuts are documented as unobservable, so ordinary execution and stepping reach the same state at the same tick.

C64 and NES have one tier, so Desk opens at the current instruction boundary. On the N64, opening Desk from Play switches the worker to the reference tier at the next frame boundary (VI FullSync). High-level play-tier tasks complete when they start, so no RSP task is half-done on either side of the switch. From then on, original Fast3D microcode replaces the high-level graphics, single-instruction CPU steps replace compiled blocks, and drawing happens in the machine worker. Game state transfers unchanged. The play tier's framebuffer lived in the RDP worker, so the first reference frame redraws the picture. Closing Desk returns to the play tier at a frame boundary.

**Stepping agrees with ordinary execution.** Tests run the same frames both ways and compare registers, cycle counts and RAM. Inspection reads memory with side-effect-free `peek`, so a paused inspection never advances the game or triggers device reads.

## What Desk shows

- **Current instruction:** its address, its live bytes read from memory, and its address-space identity. That's the C64 processor-port configuration, the NES PRG mapping, or for N64 the virtual and physical address. The observed assembly comes from `observed-source.json`. If the live bytes differ from the first observed variant (for example self-modified code, or another bank), Desk says so rather than presenting the old listing as current.
- **Generated TypeScript:** the static function `at_<address>_<opcode>` that the dispatcher runs for this exact address and opcode.
- **Named interpretation:** where a game's docs check a routine, the game's `desk/symbols.json` names the address range and links the evidence. Unnamed code stays unnamed.
- **Registers and flags:** 6502 A, X, Y, SP, P (NV-BDIZC), PC, cycles and instructions. VR4300 GPRs (64-bit), PC, HI/LO and key COP0 registers. RSP scalar registers and PC.
- **Memory:** a hex view of any address in the CPU address space. On the N64 it covers RDRAM, RSP DMEM and IMEM.
- **Breakpoints:** CPU address breakpoints, which can also be set from a named routine. **Run** continues frame by frame, rendering each frame, until a breakpoint, gap or result.
- **System diagram:** a teaching diagram connecting CPU, memory, video, sound and input to the modeled devices. It's labelled as a teaching diagram, not an original electrical schematic.

## Media identification

`/desk` accepts original files and hashes them with SHA-256 in the browser. A file whose hash matches a catalog recipe opens that game's Desk. A known game with a different hash is reported as an unsupported release, and any other file as unknown. Unknown binaries never run. Nothing is uploaded.

## Limits

Desk inspects the reference tier only. It doesn't edit memory, rewind, or map pixels back to instructions; those remain [Blue sky](BLUESKY.md) ideas. Named interpretations cover only routines the game docs check.
