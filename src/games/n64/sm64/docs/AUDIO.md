# Following the original audio microcode

The VR4300 CPU submits an audio command list to another processor: the **RSP**. The RSP has its own 32-bit scalar registers, eight-lane vector registers, 48-bit accumulators, and separate 4 KiB instruction and data memories. Its instruction words are different from the CPU's, even though some scalar operations look familiar.

ROM Studio translates both processors separately. [`transpiler/rsp.ts`](../../../../transpiler/rsp.ts) decodes original RSP words during recovery and emits static functions. [`runtime/rsp.ts`](../../../../runtime/rsp.ts) and [`rsp-vector.ts`](../../../../runtime/rsp-vector.ts) provide architectural operations. [`systems/n64/signal.ts`](../../../../systems/n64/signal.ts) supplies SP registers and DMA. In this **reference tier**, no audio command is replaced with a host implementation of that command. The planned **play tier** may run a ROM Studio TypeScript implementation of the recognized audio microcode instead; it must reproduce this tier's PCM stream on recorded routes. See [execution tiers](../../../../../docs/ARCHITECTURE.md#execution-tiers).

## The bounded audio study

`npm run cli -- boot --title sm64` first verifies CPU startup and records the exact SP start command, registers, RDRAM and SP memories. It then pauses the CPU and runs that first audio task in a separate, explicitly declared device fixture. A fresh replay executes only generated static RSP functions. The comparison includes scalar/vector state, accumulator slices and flags, all RDRAM and SP bytes, DMA, interrupt state and the functional clock.

The microcode loads itself, reads the original command list, writes output through DMA, sets its task-done signal and executes `BREAK`. This proves a bounded task executes; silent startup samples do not prove working game music. The study records its evidence under `dist/work/games/n64/sm64/analysis/startup/`, including `rsp/program.js`. The generated RSP explanation is under `game-code/rsp/`, using **IMEM offsets**, a different address space from CPU addresses such as `$80241800`.

## A readable mixer

[`code/audio.ts`](../code/audio.ts) explains the original `MIXER` handler as a sample loop. Each output combines the existing destination with a scaled input. A fractional rounding term survives the multiply and multiply-add; saturation happens after accumulation. Clipping an intermediate result would produce different samples.

The recovery checks select the handler through the cartridge's own dispatch table. Fifteen isolated fixtures cover empty buffers, one and three loop iterations, positive/negative/zero gain, signed extremes, fractional results and saturation. They compare 320 nonzero/edge-case sample positions against the named explanation, check that input samples survive, and guard the output boundaries. Both original-word execution and static replay must pass. These are declared analysis inputs rather than a claim that the game naturally emitted those commands at startup.

## Full-route PCM comparison

The current title-to-opening verifier additionally observes the AI output during both original-word execution and generated replay. Each stereo sample contributes its left value, right value and source sample rate as three little-endian binary64 numbers to a SHA-256 stream. It compares the count and digest, with a nonempty original stream required. The observer does not advance the machine or alter its buffers. Its report is `pcm.json` inside the corresponding checked playback capture. The longer current-model check passed for 236,434 stereo samples with identical source rates and digest; the [performance chapter](PERFORMANCE.md) records its source fingerprint and scope.

Matching this stream checks that execution batching preserves the modeled sound output. It does not establish analogue hardware fidelity, browser scheduling quality or audible full-speed music. Browser resampling happens after the source PCM boundary, and slow game execution can still starve the host output.

## What remains

The functional scheduler gives the RSP two ticks per three CPU ticks. Cache, dual issue, pipeline and precise asynchronous timing remain unverified. Later execution produces nonzero PCM during the logo, title and menu, and completes the original audio-session reset through its thread and queue logic. The captured [title-to-opening replay](STARTUP.md) also checks processor/device/memory consistency, separately from this first task. Neither establishes audible browser music or an independent sample-by-sample hardware match. The [graphics studies](GRAPHICS.md) complete buffer clears and a textured task. The worker player remains in progress; browser sound, complete controls, saving and progression still need acceptance.

References: [SGI's RSP Programmer's Guide](https://ultra64.ca/files/documentation/silicon-graphics/SGI_Nintendo_64_RSP_Programmers_Guide.pdf) and the [recovered SM64 audio microcode](https://github.com/n64decomp/sm64/blob/master/rsp/audio.s). They inform architecture and naming; ROM Studio executes the supplied cartridge bytes.
