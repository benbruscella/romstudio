# Blue sky: what could ROM Studio become?

**A place where old games become understandable, playable, and explorable.**

This file holds ideas beyond committed release scope. **The core ROM Desk workbench is required for v0.1**, alongside six excellent games across C64, NES and N64. [RELEASES.md](RELEASES.md) records that scope; [Project status](PROJECT-STATUS.md) tracks implementation. Loading supported media, stepping, assembly/TypeScript correlation, register/memory inspection, address breakpoints and basic system diagrams belong to that baseline. The extensions below remain possibilities unless separately promoted into a release.

## Beyond the core workbench

- Step a subroutine, game tick or scanline, extending the baseline instruction/frame controls. Explain each boundary on that machine.
- Break on an enemy spawning, a terrain write or a sound-register change, extending the baseline address breakpoints.
- Click a pixel: which tile, sprite, palette entry and instructions produced it?
- Click a lemming: show its original memory record, animation, state machine and the handler updating it.
- Click a sound: show the original driver, register sequence and synthesized waveform.
- Search concepts such as collision, player speed or timer and land on checked explanations, not guessed symbols.
- A command palette: “take me to the next level load”, “show writes to player X”, “explain this branch”.
- Bookmark a source address together with the correct bank, memory epoch, build hash and input history.

## Time travel and alternate histories

- Rewind to the instruction that changed the pixel or caused a death.
- A filmstrip of machine checkpoints with keyboard/controller input along the timeline.
- Fork a run: what if I had pressed jump one frame earlier?
- Compare two routes side by side and show their first meaningful divergence.
- Bisect a regression automatically to the first changed instruction, device event or byte.
- Reproduce a reported bug with a tiny shareable input log and pinned build identity.
- A “why did this happen?” chain from visible effect back to memory writes, instructions and source bytes.
- Deterministic replay capsules: original-media identities, declared launch conditions, recorded controls and expected checkpoints.

## The machine lights up

- Interactive CPU/bus/RAM/video/sound/controller diagrams. Highlight actual reads, writes, IRQs and DMA.
- Zoom from a game action to a memory-mapped register, then to the documented chip behavior.
- A cycle ruler for CPU instructions, raster beam, DMA waits, interrupt entry and audio writes.
- Bank-switch animation: show which physical ROM bytes occupy a CPU address now.
- Watch a disk loader stream, unpack, relocate and turn data into executable instructions.
- Memory archaeology: known, unknown, loaded, written, executed and self-modified regions in different colors.
- Real electrical schematics beside clearly labelled simplified teaching diagrams, with source attribution.
- Compare the C64 and NES: common 6502 ideas, different buses, video, sound, controllers and decimal behavior.
- A virtual logic analyzer built from the modeled bus, clearly distinguished from a measured hardware trace.

## Learn the game by changing one thing

- Guided lessons: how a digger cuts terrain, how a tower rotates, how scrolling works, why fixed-point movement matters.
- Inline questions: predict the next branch or register value, then step to check.
- Annotated state-machine diagrams that follow the current game state.
- A side-by-side translation ladder: bytes → assembly → precise TypeScript → checked named routine → explanation.
- Reveal the clever tricks: multiplexed sprites, packed level data, shared tables, decimal counters and self-modifying operands.
- Interactive diagrams generated from reviewed annotations, with unresolved edges visible.
- A lesson builder: turn a verified replay and a few breakpoints into a walkthrough.
- Accessibility modes: slower play, larger code, searchable captions for important visual/audio events and keyboard-only exploration.

## Controlled experiments and remixing

- Change gravity or release rate in a local experimental fork and see which original constants matter.
- Swap a palette or tile in a local patch and see the exact affected bytes and rendered result.
- Build a level editor only after the level format is understood and verified.
- Make a modification as a small patch plus source-media hash, rather than redistributing an entire game image.
- Reassemble an unmodified annotated study into the identical original ROM, where the system/format supports that workflow.
- Compare original and modified runs under identical input and timing.
- Experimental branches are labelled; they never silently become the reference game or its evidence.
- A museum of engine tricks: the same effect implemented differently across games and systems.

## Sound laboratory

- Solo a voice, inspect envelopes and identify the instructions programming it.
- A timeline of SID/APU register writes synchronized with assembly and audio playback.
- Compare approximate synthesis with independently captured hardware evidence.
- Extract the structure of a music engine: instruments, patterns, tempo, effects and driver code.
- Spectrograms and waveform viewers that connect a sound artifact to a specific model limitation.
- Teach how the same CPU budget is shared between music, drawing and gameplay.

## Community-powered game studies

- Each game becomes a technical book with Play, Learn and Desk entry points.
- Contributions can be small: name one routine, document one RAM field, explain one asset format, add one regression.
- An annotation vocabulary separating measured fact, original-byte observation, verified interpretation and hypothesis.
- Review a symbol or explanation with the trace and source address directly alongside it.
- Share links to an exact routine and machine state, without uploading a user's original ROM.
- Coverage maps show what is decoded, executed, explained and independently verified as distinct dimensions.
- Study quality badges based on evidence, not the number of green tests alone.
- Import compatible community symbol/disassembly work with proper attribution and explicit provenance.
- A contributor workbench suggesting small unanswered questions that have useful surrounding evidence.

## Community game versions and a remix gallery

People should be able to understand a game, change it, and submit their version for others to play and learn from. A small palette edit, a new level and a substantial TypeScript change should all have a useful contribution path. This community platform is a future extension, separate from the committed v0.1 workbench.

A possible contributor journey:

1. Open a supported game in Desk and choose **Remix**. The project records the exact original-media identity and compatible ROM Studio build.
2. Change something through a supported asset editor or a source project. Start with decoded formats such as palettes or known level structures; expose game-code changes through source-linked TypeScript and reviewed patches.
3. Run a before/after comparison and record a short input replay demonstrating the change. Add an explanation so the modification also becomes a lesson.
4. Export a version bundle containing changes, a manifest, attribution and verification inputs. Original media stay outside the shared bundle; another player supplies the matching originals.
5. Submit the source bundle for review, initially through pull requests. Reviewers can reproduce the build, inspect the diff and play the demonstration.
6. Publish an accepted version in a gallery with **Play**, **Learn**, **Remix** and **Compare with Original**. Show compatibility, authorship, parent versions and verification scope.

The bundle would record base ROM SHA-256 identities, the parent modification/version, compatible toolchain version, source changes or reproducible patches, build options, credits and a changelog. Replays describe expected changed behavior. Builds receive their own identities, so a link to a modification cannot silently become a different version.

**Original behavior and intentional changes need separate checks.** Keep the unmodified reference's regression checks intact. A modification adds assertions for its own behavior—such as altered jump height, a new entrance or a changed palette—instead of requiring its entire machine state to equal the original. Unrelated regressions still matter. Deterministic replays and source links make review practical.

Community previews should run in isolated browser contexts and display their authorship and modification identity. The gallery can distinguish submitted, reproduced and reviewed versions without suggesting that one passing replay proves full compatibility. Players should be able to return to the original build and compare versions under the same inputs.

Make room for contributors who do not write code: document one routine, name a RAM field with evidence, explain a sprite format, contribute a replay or help test a version. Guided challenges could turn a mystery in the game into a small collaborative investigation. Credits should follow the contribution and remain visible through remixes.

The long-term community loop is **Play → Inspect → Understand → Change → Share → Learn**. A published version can teach both how the original game worked and how the contributor changed it.

## Strange, wonderful research tools

- “Find another game using a similar decompressor” through structural code comparison.
- Detect repeated routines and explain what differs across releases or PAL/NTSC versions.
- A visual binary diff that understands banks, instructions, graphics and data tables.
- Find likely unused content, then test whether any original execution reaches it.
- Discover a game's random-number generator and replay its consequences.
- A speedrun laboratory showing frame windows, collision checks and input sampling.
- A bug museum: recreate an original bug and explain the code that produces it.
- A compiler museum: what patterns suggest handwritten assembly, a compiler, a packer or a particular development tool?
- Generate a verified miniature example of a technique without copying the entire commercial game.
- Compare source-level clarity against the exact machine behavior it describes; flag where a beautiful explanation has become inaccurate.

## Guardrails that keep the magic useful

Every view should identify its build, system, bank/epoch and source evidence. A generated instruction translation is not automatically a meaningful game routine. A simplified schematic is not an electrical measurement. An uploaded file is not automatically executable. Internal replay consistency is not independent hardware parity.

The best version of ROM Studio makes those distinctions easy to understand while remaining fun to explore.
