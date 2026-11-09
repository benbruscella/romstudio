# Making SM64 fast enough to play

Full-speed browser execution is the goal. Reaching Mario outside the castle establishes useful execution coverage; a game running at a few frames per second still needs substantial work. Since 9 November, full speed is planned through a separate play tier; see [Two execution tiers](#two-execution-tiers-9-november). The owner's latest report was roughly 4 FPS. Earlier measurements on the isolated browser were slower. Those observations come from different machines/builds and are not a controlled comparison.

## Where the time goes

The current generated program contains static functions for original CPU and RSP instruction words. The browser selects those functions; it does not decode new instructions or compile them dynamically. This preserves instruction-level source correlation, but calling a function for each instruction, fetching guarded words, checking devices and executing vector arithmetic all have a host cost. The RDP also draws in software. Translating instructions is a foundation, not the final optimizing compiler.

```text
CPU functions → bus/DMA → RSP functions → RDP commands → pixels
                                    ↘ audio buffers in RDRAM → AI → stereo PCM
```

A worker profile of the earlier browser package during castle gameplay found time in idle-loop probing, instruction-memory reads, RSP vector operations, triangle drawing and texture sampling. It also showed scheduling idle time. This is a guide to investigation on that build, not proof of the current candidate's costs. The local evidence is `dist/work/sm64-pre-span-gameplay.cpuprofile` and its JSON summary. The page was paused again after profiling.

## Optimizations under verification

- **Instruction selection:** paged CPU code uses word-indexed arrays for immutable instruction addresses. Only addresses with multiple recovered word variants need a second lookup. The page dispatcher caches its immutable page function.
- **One fetch per instruction:** the dispatcher passes the freshly fetched word into the instruction guard. Direct instruction-function callers still fetch and validate it. Faults still occur through the CPU's ordinary exception path.
- **Idle candidates:** compiler metadata avoids testing ordinary instructions as wait loops. The runtime inspects the actual RDRAM words, branch phase, CPU permissions, pending interrupts and device deadlines before coalescing anything. Metadata alone cannot authorize a skipped interval.
- **RSP spans:** static compiler metadata rejects impossible span starts before probing IMEM. Existing spans group only permitted register/private-DMEM work, stop before device events and retain processor counts and phases. Control accesses, branches and BREAK remain barriers.

## Bounded RSP execution

The bounded path adds a separate `runLocal` entry. It follows original static RSP functions through loops, calls, returns and delay slots for at most 256 instructions. Its ordinary path fetches each executed word once and passes that word into its guard. The guarded control-wait optimization described below can coalesce repeated pure fetches within a stable event window. Ordinary instruction stepping remains available. This is event-bounded execution of original operations; it does not replace microcode with a guessed game routine or introduce a browser decoder.

The system may use this path only while the CPU is in its checked RDRAM wait loop, without an accepted interrupt. It stops strictly before the earliest Count/Compare, PI, SI, SP DMA, AI sample or VI event. Only register/private-DMEM work and safe branches may run freely. Packed vector transfers also check alignment and byte element at their actual instruction boundary.

Specific read-only SP status/DMA and DPC current/status registers remain constant within that event window in this functional model. The system explicitly grants that additional guarantee; generic callers do not get it by default. Device writes, semaphore reads, BREAK, unsupported words and invalid delay-slot branches stop the batch before execution. Future changes to asynchronous device behavior must preserve these assumptions or shorten the deadline.

Because no permitted operation can change the CPU's wait words or an event-visible value, the system can execute the local RSP work first and then commit the exact corresponding CPU/device interval. It preserves the retired instruction counts, branch pipeline and two-RSP-instructions-per-three-CPU-ticks phase. A stop at the next unsupported instruction still takes the ordinary path, including its pending-tick continuation. Host time-budget checks now follow elapsed guest work so larger batches do not multiply the amount of work between yield checks.

The first prototype instead emitted inline straight-line chunks. It matched state but barely changed a 20-million-tick measurement, so that emitter was removed. A fresh browser profile of the prior checked candidate showed substantial time in idle probing, span preparation, the player loop and device-clock updates. Instrumentation then found frequent stops at SP DMA/status reads and packed vector transfers. Those measurements informed the bounded path above.

Synthetic comparisons cover branches and every tested prefix through 256 instructions, IMEM wrapping, mutable microcode variants, packed alignment failures, semaphore barriers, all three RSP clock phases, timer/DMA/video/audio boundaries and stop/resume state. Generated CPU and RSP TypeScript type-check against the runtime declarations. The unit run selected 256 tests: 254 passed, with the two loopback tests passing separately; format/lint/types passed.

A final 20-million-tick title comparison matched processor/device state and both RDRAM/SP hashes against the previous `6d5bc504…` package. It took about 22.3 seconds for the prior package and 15.6 for the candidate, approximately 43% higher throughput. It grouped 5,174,283 RSP instructions into 97,768 runs. `sm64-final-runs-acceptance.json` records the source snapshot and scope. This is a Node analysis measurement, not browser FPS.

That model's original/static replay then passed all five checks over FullSync 131 → 284, under fingerprint `866c72d751d43f83e856d581fc53d0c0e2a7f579affe1796dde9ddeeb034b858`. Its snapshot covers 111 files, and 13 hashed capture files preserve its evidence. The original and static AI streams each contain 236,434 stereo samples, with identical source rates and SHA-256 `8a0e5d6ae4bd72519b537cd558a1c7157838ac12e750289aa5890e7e412c8de7`. The earlier `6d5bc504…` title-fixture origin remains explicit; earlier startup is not reverified. Browser performance and wider gameplay still need separate acceptance.

The paired browser title test then measured 2.10 tasks/second for `6d5bc504…` and 2.69 for `866c72d7…`, approximately 28% higher throughput. Both ran FullSync 141 → 176 in separate headless Chrome pages at a 1200×900 viewport, with no concurrent analysis job. Pause and page-error checks passed. `sm64-runs-browser.json` records this pair; it should not be combined with earlier differently timed runs to claim a cumulative gameplay speedup. The game remains below full-speed acceptance.

The Number-based RSP accumulator still represents signed 48-bit values exactly and has independent BigInt comparison fixtures. Faster arithmetic must preserve the console's widths, saturation and flags.

## Register, vector and rendering costs

A later worker profile outside the castle identified RSP vector execution and the software RDP as the largest costs. Rasterization, pixel writes, filtered sampling, coordinate handling and the combiner together account for nearly half its samples. The CPU-only changes improved a short title measurement by just 4%, so investigation continued into those larger costs. `sm64-runs-body.cpuprofile` preserves the profile; its roughly 3 tasks/second ran alongside analysis and is not a controlled speed comparison.

The next implementation reduces work at three hardware boundaries:

- CPU/FPU word operations share typed-array views of the original 64-bit register bytes. Guarded single-precision math keeps exact rounding/exception behavior, with the BigInt path retained as a numerical reference and fallback. [CPU](CPU.md) explains the conditions.
- Vector operations read lane-local inputs directly. Only a selected VT operand that aliases the destination needs a snapshot; reciprocal/move instructions consume all needed inputs before writing. Alias tests cover every implemented operation and all 16 selectors, including shared VS/VT and untouched lanes.
- The rasterizer derives integer sample intervals per scanline. Full interior pixels avoid eight repeated coverage comparisons; boundary pixels retain the original samples and centroid. Texture sampling computes four neighboring coordinates once and holds three filter taps as packed colors, returning the same owned RGBA tuple. All original coverage samples and filter taps remain present.

Independent scalar comparisons cover 400 triangles with both coverage modes and 2,000 texture configurations across supported formats, shifts, masks, mirrored/clamped seams and negative coordinates. These preserve the current functional renderer; they do not improve its documented hardware precision. A 20-million-tick comparison against `866c72d7…` matched architectural state, RDRAM and SP memory, taking about 21.0 seconds versus 16.9 seconds, approximately 25% higher throughput. `sm64-render-acceptance.json` records the source snapshot and scope. This is a Node title workload, not gameplay FPS.

The longer candidate replay passed all five comparisons over FullSync 131 → 284 against the explicitly selected `866c72d7…` original endpoint and its complete PCM stream. Its fingerprint is `1e4e4e292f467ba73b40dcdc2b6dd41265de73ac9650b2ed8a635b80a5ec25a4`, with 113 source/configuration files and 13 hashed capture files. All 236,434 stereo samples and source rates retain the earlier SHA-256 stream. It records that historical reference separately from current source; it is not a fresh original recovery under the changed implementation. Cache reuse rechecked its dependency snapshot and capture hashes.

The paired browser title workload, FullSync 141 → 176 at 1200×900, improved from 2.78 to 3.49 completed tasks/second, approximately 25%. Pause and page-error checks passed. `sm64-render-browser.json` records the comparison, while `sm64-render-build.json` and `sm64-render-cache.log` retain the longer replay and cache audit. The selected 266 unit tests are accounted for, including the two loopback tests run separately; all three real-cartridge SM64 integration tests and format/lint/types also passed. This is still below full speed and does not replace live gameplay acceptance.

The same package then passed the original menus/opening and visually checked movement, jumping, an airborne B kick and a separate grounded punch, with pause/resume and no recovery stop or page exception. The first input sequence was absorbed by the tutorial; its captures are retained as `sm64-render-dialog-*`, not accepted as movement. The repeat after the dialog closed is `sm64-render-gameplay.json`, with separate grounded-punch captures. A later 20-second profile in actual play measured 4.75 completed tasks/second while facing the hillside. That scene differs from the title and earlier castle view; it is not a controlled gameplay speedup comparison. `sm64-render-body.cpuprofile` still identifies vector execution and pixel writing/combining as major costs. The local canonical package and development library were refreshed after checking hashes, retaining earlier packages and analysis. Full-speed play, usable browser audio and wider progression remain unaccepted.

## Read the measurements by scope

A 20-million-functional-tick title comparison against the previous checked package matched CPU/device snapshots and RDRAM/SP hashes. Its first timing was worse: about 27.4 seconds for the earlier package and 31.1 seconds for the candidate. That result is retained in `sm64-dispatch-acceptance.json`.

A separate component-isolation run used 10 million ticks from the same title state, repeated in reverse case order. The previous package took about 13.0–13.2 seconds; the combined candidate took about 9.5–9.7 seconds. CPU dispatch alone also improved the current runtime's result. Every case ended with identical architectural state and memory. `sm64-dispatch-isolation.json` records the source snapshot and individual runs. The workload, warm-up and ordering matter: these results do not establish a universal speedup or browser gameplay FPS.

The longer current-model title/menu replay passed all four processor/device/clock, RDRAM, SP memory and controller checks over FullSync 131 → 284. Its fingerprint is `6d5bc50457e5ab20ccc3207b260aa38e6b2b61d94a8fd59f194295586491dc44`, with 111 source/configuration files in the model snapshot. It explicitly starts from the earlier `7ff1bd4…` title fixture; earlier startup is not reverified by this run. Twelve hashed capture files include the original endpoint for future performance fixtures. Reusing this real checked cache also passed its snapshot/file checks without rerunning recovery.

An isolated headless Chrome comparison then ran the same untouched title workload, FullSync 141 → 176, after loading each package separately. The earlier package averaged 1.43 completed graphics tasks per second and the candidate 1.85: approximately 30% higher throughput. Both paused correctly and reported no page exceptions. `sm64-dispatch-browser.json` records the source fingerprints, clocks and counters. This measures completed RDP FullSync tasks on this title workload, not sustained gameplay, native regional pacing or a direct comparison with the owner's 4 FPS observation. That headless browser used software graphics.

Each comparison uses separate checked packages. At that stage, the `1e4e4e29…` candidate became the local canonical package; earlier packages and analysis remain preserved. The original cartridge, selected fixture origin and model-source snapshot stay explicit. Full-speed gameplay and usable browser audio are still unaccepted.

## Scanlines and prepared pixel state (9 November)

The throughput diagnosis matters: the recorded title workload performs about 3.75 million functional CPU ticks per completed graphics task, consistent with the PAL model's 93.75 MHz / 25 Hz. Roughly 13 million ticks/second explains a few completed tasks per second. Worker yielding is not the main limit. This measures our functional model, not an independently verified hardware cycle count.

The next checked package is `dbe448e25dadf8bc50055036a877527be56767b00befc6abf9347ad4312d81de`. Its software RDP uses reusable scanline storage instead of allocating fragments and shade/texture/depth arrays per pixel. A command-local writer resolves framebuffer, depth and blender state once. Combiner selectors become scratch-register indices, including both feedback cycles; texture descriptors select a packed fetch function once per draw. The tuple-based sampler and scalar pixel writer remain numerical references.

Plane bases are shared per row, but each pixel retains the reference expression's evaluation order. Repeated floating-point addition across a row can change a quantized edge pixel, so this implementation does not assume that incremental addition is equivalent. Coverage samples, centroid selection and all three filter taps remain present. The documented hardware approximations remain unchanged.

Checks cover 400 triangles, 2,000 texture configurations, 12,000 combiner configurations in both cycle modes and 3,000 framebuffer/depth/blend configurations, including error order, unsupported evaluated inputs, framebuffer/depth overlap and hidden bits. A 20-million-tick ABBA comparison against `1e4e4e29…` matched architectural state, both memories and exact PCM/source-rate hashes. It measured about 19% higher wall throughput; the run includes the RSP entry cache and specialized multiply helper as well as the scanline changes. It is not an isolated renderer speedup.

The longer replay passed all five comparisons over FullSync 131 → 284 against the explicitly selected `866c72d7…` original endpoint, including all 236,434 stereo samples and rates. The source snapshot covers 135 files and the 13 captured file hashes remain explicit. Original recovery was not rerun under the new source. `sm64-software-build.json` and `sm64-spans-compare.json` retain the scopes and identities.

A fresh paired browser title test measured **3.48 → 4.44 completed tasks/second**, approximately **28% higher throughput**, with unchanged PAL clocks. Both ran FullSync 141 → 176 at 1200×900 in isolated headless Chrome; pause and page-error checks passed. `sm64-spans-browser.json` records this comparison. It is still far below full speed and is not a matched castle-grounds gameplay measurement. At this checkpoint, formatting/lint/types, all 272 unit tests (including two separately permitted HTTP tests) and three real-cartridge integration tests passed.

## Evaluate larger changes in the browser

Several larger RSP/CPU block experiments passed their output checks but did not justify their cost. The first multiply-only/coupled-scheduler package (`cfaf9651…`) was about 22% slower in a paired production-browser title run. Coherent local RSP blocks, IMEM version caching and lane-fused multiplies were then tested on a repeatable castle fixture. The 100-million-tick ABBA comparison (`sm64-core-lab/e82f7a3dcd9345dd/`) improved wall throughput by only about 1%, with essentially unchanged renderer-process CPU cost. Those compiler changes were removed from active source; their exact sources and reports remain under `dist/work/` for analysis.

**Node used `--max-opt=1 --no-concurrent-sparkplug` because earlier optimizing-engine runs crashed natively.** Since 9 November only `--no-concurrent-sparkplug` is needed, about eight times faster in Node; measurements in this section predate that change. Node's absolute throughput is still lower than Chrome's. Output checks remain useful there, but Chrome measurements decide browser performance. Concurrent host load also moved Chrome wall times substantially. Later comparisons therefore record renderer-process CPU deltas in addition to wall time, exclude warmup and compare identical guest work in reverse case order. Profiled runs include profiler overhead and are labelled separately.

The castle fixture is an original-input continuation from the checked FullSync 284 endpoint to 2100. It dismisses the opening dialogs and leaves Mario outside the castle, without changing game state. Its state, RDRAM, SP memory, input transitions and screenshot are hashed under `sm64-core-lab/fixtures/castle-2100/`. It is a core workload, not fresh original recovery or native keyboard acceptance. At 100 million ticks, all compared variants retain the same complete architectural state, both memories and 34,128 stereo samples with their original source rates.

The current narrower experiments batch otherwise idle device calls until an event or MMIO observation, copy pure DMEM vector transfers as big-endian halfwords and recognize guarded three-instruction RSP status-poll loops. Ordinary instruction/device execution and the byte-wise transfer implementation remain references. Full replay and actual-browser performance must pass before adopting a new package. Unfinished fixtures and experiments under `dist/work/` are not production build inputs.

## Device deadlines, DMEM transfers and control waits (9 November)

The latest checked local package is `b163e6c9370e4ad17f960315f9cfac59a55a18a1a0b7b063df4d69d18ec18ebb`, with 720 exported files. Its 135-file dependency snapshot and 13 capture hashes remain explicit. FullSync 131 → 284 passes all five comparisons against the earlier original endpoint, including the same 236,434 stereo PCM samples and source rates. This is current static replay against captured original evidence, not fresh original recovery or hardware parity.

The changes preserve ordinary instruction execution:

- Play mode keeps CPU Count current every tick, while deferring otherwise idle PI/SI/VI/AI/SP calls only until the earliest device event. MMIO and snapshots synchronize the elapsed interval before observation or mutation. RSP execution retains its original 2:3 clock phase. Ordinary per-tick device advancement remains the reference.
- The compiler resolves simple vector-transfer shapes once. A pure live DMEM view permits big-endian halfword copies, retaining partial vector bytes, element rotation and 4 KiB wrapping. Observable buses keep byte callbacks and the byte-wise implementation.
- A guarded `MFC0 → BEQ/BNE → NOP` status wait can account for complete iterations while the CPU waits and the status is stable strictly before an event. All three actual words, the branch condition, delay state and budget are checked. PC, GPRs and retired instruction counts match ordinary execution; semaphore reads and device writes remain barriers.

A 100-million-tick reverse-order castle core comparison retains identical complete state, both memories and all 34,128 stereo samples/rates. It measured roughly 6% higher wall throughput and 4% less renderer-process CPU time than the checked scanline package. It coalesced 800,478 status-wait instructions and used 855,176 device groups. `sm64-core-lab/7d4a9d0720d481b6/` preserves that experiment's exact served modules. This excludes production presentation/audio-host overhead.

The packaged app/worker/player then ran the same original-input castle fixture in the order previous-default → scanlines → latest → latest → scanlines → previous-default. Each measured FullSync 2110 → 2140 at 1200×900, with no other owned recovery or benchmark job running. Mean completed-task rates were **1.02, 1.70 and 1.67 FPS**, respectively: the latest package is about **64% faster than the previous local default**, while the extra changes beyond scanlines are within native-player timing noise. External host load remains uncontrolled. `sm64-castle-player-benchmark.json` and its summary retain individual results; these are not a full-speed claim.

Native input also confirmed movement, jumping, a grounded punch, Start and browser pause/resume without a recovery stop or page exception. Captures are `sm64-castle-deadlines-*.png`; the input report is `sm64-castle-player-controls.json`. This uses the production player with a declared castle launch fixture, and does not replace the separate opening replay. The moving hillside view showed roughly 4–5 FPS and differs from the slower wide castle view. Browser audio activation succeeded; usable real-time sound remains unaccepted while emulation is slow.

Formatting/lint/types pass. All 277 unit tests are accounted for, including two HTTP tests run separately with loopback access, and all three pinned-cartridge SM64 integration tests pass. The local default now uses this checked package, preserving earlier exports and analysis. No source or ROM was pushed or deployed. A further prepared-state cache matched the scalar tests and full castle state/memory/PCM but showed effectively unchanged wall and renderer CPU cost. It was not adopted. `sm64-core-lab/7d26d49bf3b3641e/` retains that comparison; `sm64-core-lab/output-audit.json` independently checks the saved state and memory/audio hashes across all completed core comparisons.

## Two execution tiers (9 November)

Reference-path optimization has produced useful but bounded steps. Scanline rendering gained about 28% on the title workload. Device deadlines and control waits gained about 6% in the castle core, and broader RSP/CPU block prototypes about 1%. The wide castle view runs near 1.7 FPS and the hillside view near 4–5 FPS, against PAL's 25. Full speed needs roughly seven times the current throughput.

A read-only budget measurement ran 30 million functional ticks from the `b163e6c9…` launch checkpoint. It used Node's restricted optimization tier, so its absolute speed is not meaningful; the proportions are:

- The CPU spent 79% of ticks in its checked idle loop and retired about 6.2 million ordinary instructions, roughly 21% of ticks.
- The RSP executed 0.32 instructions per tick and was halted in about 40% of sampled ticks. Its work is real computation, not a spin-wait that could be skipped.

At 93.75 MHz, full speed therefore needs about 20 million CPU instructions and 30 million RSP instructions per second, mostly eight-lane vector operations, plus software RDP drawing. This is one scene; gameplay proportions differ.

The owner then adopted [execution tiers](../../../../../docs/ARCHITECTURE.md#execution-tiers). The earlier sections of this chapter describe the **reference tier**, which remains the verification baseline and the execution behind Learn and ROM Desk. The **play tier** plan is:

1. Measure RSP instructions per task type, audio versus graphics, on the castle fixture.
2. Recognize the cartridge's audio and Fast3D microcode by their exact bytes and implement their commands in TypeScript. The audio implementation should reproduce the reference PCM stream exactly. The graphics implementation first sends RDP commands to the existing software renderer, so frames compare directly with the reference tier.
3. If drawing then dominates, run the RDP in a parallel worker or on the GPU, with a declared picture tolerance against reference frames.
4. Compile hot CPU routines into larger guarded blocks if CPU execution becomes the limit.

Play-tier acceptance replays the opening and castle routes on both tiers. Game state at frame boundaries and PCM must match; pictures must match or stay within the declared tolerance. Play and Desk exchange state between RSP tasks. Unrecognized microcode runs its original instructions in both tiers.

## Play tier: first implementation (9 November)

**Task split.** Over 40 million ticks of the castle fixture, graphics tasks used 90% of RSP instructions: about one million per frame across 10 tasks. Audio used 10% across 22 tasks. Graphics therefore came first.

**High-level Fast3D.** [`fast3d.ts`](../../../../systems/n64/fast3d.ts) implements the cartridge's Fast3D 2.0D graphics microcode ("RSP SW Version: 2.0D, 04-01-96"). It recognizes the microcode by FNV-1a hashes of its text (`e8812872`) and data (`c5a5d5a5`) images. It interprets the display list: matrices, vertices, lighting, texture generation, fog, near-plane clipping, culling and RDP triangle setup. It feeds the same software RDP. Resumed (yielded) tasks, other microcode and any unimplemented command run the original instructions, and a fallback discards buffered output before anything is drawn. Synthetic tests are in [`fast3d.test.ts`](../../../../systems/n64/fast3d.test.ts).

Compared with the reference tier over six castle frames, every graphics task stayed on the fast path. FullSync cadence was unchanged at about 3.75 million ticks per frame. 1.7% of pixels differ by more than 24 levels (mean difference 2.1), almost all on triangle edges. Truncating screen coordinates toward negative infinity matched best; rounding gave 4.4%. A sampled long seam across the ground is a crack in the reference renderer's output; the play tier draws that ground continuously.

**Parallel RDP.** In the browser, the machine worker streams each task's RDP commands, triangles and texture-load byte snapshots to [`rdp-worker.ts`](../../../../systems/n64/web/rdp-worker.ts). That worker owns a private RDRAM mirror and returns finished frames, with at most two tasks in flight. The guest sees FullSync and the DP interrupt immediately; it never reads RDP output. Over six frames, streamed frames were byte-identical to synchronous play-tier frames and machine ticks were identical. The stream averaged about 611 KB per frame.

**Browser measurement.** Single 15-second Chrome runs from the castle fixture, after warm-up, on the owner's Mac, with the same modules throughout (`?tier=reference` selects the reference tier):

| Configuration              | FPS  | Guest ticks per second |
| -------------------------- | ---- | ---------------------- |
| Reference tier             | 7.3  | 27.2 million           |
| Play tier, synchronous RDP | 11.1 | 41.5 million           |
| Play tier, parallel RDP    | 13.2 | 49.4 million           |

These are uncontrolled single runs on a different machine from earlier headless measurements, so they are not comparable with earlier tables. The machine worker is now fully busy. Its profile is 47% generated game-code pages, about 17% VR4300 runtime, about 25% per-tick scheduling and about 6% audio microcode. Each CPU instruction still pays for page dispatch, a word guard, `begin`/`finish`, string-dispatched FPU operations and per-tick device work.

**Compiled CPU blocks.** [`vr4300-blocks.ts`](../../../../transpiler/vr4300-blocks.ts) compiles the same recovered instructions into 52,126 basic-block functions at build time (`game-code/play-blocks.js`, about 64 MB of source). A block runs from a branch target or fall-through address through the next branch and its delay slot. It checks every original word on entry and does nothing when any word differs. Common integer operations use exact 64-bit arithmetic on 32-bit register halves instead of BigInt. KSEG0/KSEG1 RDRAM loads and stores are direct; other accesses, faults and rare operations use the reference lowering. Time is accounted per block. A running RSP catches up after each block at its 2:3 ratio, and interrupts are taken at block boundaries. The reference tier keeps exact per-tick lockstep. [Tests](../../../../transpiler/vr4300-blocks.test.ts) compare block and per-instruction results, including 64-bit carries, delay slots, branch-likely nullification and changed words.

Over six castle frames, 99.95% of CPU instructions ran in blocks. Frames were pixel-identical to the play tier without blocks, FullSync cadence matched, and interrupt and exception counts were identical.

**Real-time pacing.** The worker now caps guest time at the 93.75 MHz functional clock, at most 20 ms ahead of wall time; after a stall it restarts rather than sprinting. Until now the player could never outrun the console.

| Castle fixture, Chrome, owner's Mac | FPS   | Guest ticks per second |
| ----------------------------------- | ----- | ---------------------- |
| Play tier with blocks, unpaced      | 25.7  | 96.5 million           |
| Play tier with blocks, paced        | 25.05 | 93.7 million           |

The paced run's worst second was 24.97 FPS: **full PAL speed on this scene**, with the machine worker idle 48% of the time. The title screen with the animated Mario head ran at 17.9 FPS with no idle time; its audio microcode, still on original instructions, takes about 20% of the machine worker.

**Next.** High-level audio, then FPU fast paths. Not yet done: a rebuilt package, opening-route acceptance, Play-to-Desk state transfer and longer memory observation. The shared software RDP no longer draws outlines along interior triangle edges: anti-aliased blending without FORCE_BL now requires no coverage overflow and a pixel not clearly in front of memory, as on hardware. This changes reference-tier frames, so replays pinned to earlier captured endpoints no longer match; a fresh recovery captures new ones.

## Reference-tier constraints

Retain original instruction boundaries for ROM Desk stepping. An optimized block must be bounded by interrupts, DMA, exceptions and mutable code; paused inspection must agree with ordinary execution. Source maps must continue to explain which original words produced its TypeScript. See the shared [IR direction](../../../../../docs/ARCHITECTURE.md#compiler-direction-explicit-instruction-and-control-flow-ir).

In either tier, increasing a displayed speed multiplier, dropping audio samples or changing guest clocks would not establish full-speed execution. Acceptance needs sustained original controls, correct regional pacing, usable sound and ordinary play on the actual browser build.
