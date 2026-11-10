# From cartridge instructions to an N64 machine

The cartridge contains MIPS machine words. ROM Studio decodes them during recovery and emits guarded TypeScript functions for recovered address/word variants. The code study shows observed functions alongside the original bytes. A declared static coverage envelope can also include unvisited words; those are labelled separately from observations. Larger programs use address pages. A browser package contains static generated JavaScript; the decoder and compiler stay in the tools.

## Four layers

| Layer                    | Responsibility                                                                                        | Source                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Original game code       | Startup, queues, threads, allocation, engine loading and task submission                              | Generated `game-code/program.ts` and its observed source map |
| CPU architecture         | Registers, word/doubleword operations, delay slots, control registers and floating point              | [`runtime/vr4300.ts`](../../../../runtime/vr4300.ts)         |
| N64 devices              | RDRAM, cartridge DMA, serial controller/save protocol, video and audio interfaces, SP memory/DMA      | [`systems/n64/`](../../../../systems/n64/)                   |
| Recovery and explanation | Pinned cartridge identity, declared startup fixture, original/static comparison and explanatory names | [`recovery/`](../recovery/) and [`code/`](../code/)          |

The RSP has a separate scalar/vector architecture and translator, described in [Audio](AUDIO.md). Its generated functions live under `game-code/rsp/`; CPU mappings stay under `game-code/`. The CPU and devices do not contain Mario movement or game rules. The original game creates its own threads and runs its own interrupt handler. A disabled FPU access enters that guest handler, allowing the original operating system to enable and restore floating-point state.

## Why a 64-bit CPU needs care

MIPS word instructions still operate on 32 bits and sign-extend their result into 64-bit registers. Doubleword instructions preserve all 64 bits. `bigint` prevents the loss of integer bits above JavaScript's exact integer range. Register zero always reads as zero.

The runtime also views the same register bytes as pairs of 32-bit words. Ordinary word reads, sign-extended writes and address additions can use those words without allocating a BigInt. These are shared views, not cached copies: doubleword writes, direct inspection and checkpoint restoration immediately appear in both. Host word order is detected separately from the N64's big-endian bus. [Register tests](../../../../runtime/register-words.test.ts) compare full values and address-width faults with BigInt calculations.

A branch normally executes the following instruction before changing destination. An untaken **likely** branch discards that instruction. `ERET` returns directly from an exception and has no delay slot. An exception in a delay slot records the branch address and a delay-slot flag so the guest handler can resume correctly. These differences are exercised by the CPU tests.

## Floating-point translation

The FPU has raw register bits as well as numeric formats. In paired-register mode, an odd word register selects the high half of the preceding even register. A doubleword load and two independent word loads therefore need different interpretations.

Finite arithmetic retains an integer significand and binary exponent until the final rounding step. For example, converting **2⁶⁰ + 2³⁶ + 1** directly to single precision rounds upward. Converting through a JavaScript number first can lose the last bit, turn the value into an exact tie and incorrectly round downward. The [binary arithmetic tests](../../../../runtime/binary-float.test.ts) include that case, rounding directions, division, square root and independent IEEE host comparisons.

Selected single-precision operations now have a guarded native-number path. A product of two 24-bit significands is exact in binary64; addition/subtraction uses a residual check before accepting its intermediate. One binary32 rounding then sets the original flags before writing the destination. A lost residual, tiny/overflow result, unsupported operand or different arithmetic rounding mode uses the retained integer-significand path. Finite comparisons, raw moves and checked word conversions have their own guards. Division, square root, double arithmetic and wide integer conversions retain the general implementation. [FPU comparisons](../../../../runtime/vr4300-fpu.test.ts) exercise both paths, register aliasing, rounding modes and enabled traps; enabling a trap must preserve the old destination.

This remains an incomplete FPU: arithmetic with NaN/infinity operands, some reserved encodings and other architectural cases still stop explicitly. Passing finite arithmetic checks does not establish complete VR4300 compatibility.

## CPU addresses and physical addresses

The CPU's virtual address is not automatically an N64 bus address. KSEG0/KSEG1 addresses bypass the TLB; mapped regions use paired even/odd pages, a page mask, physical frame numbers and address-space IDs. The translation adapter lives in [`vr4300-memory.ts`](../../../../runtime/vr4300-memory.ts), between the CPU and the physical bus. RSP and device DMA continue to use physical addresses directly.

The difference matters in Mario's title-screen model loader. Its virtual list at **$04000650** maps to RDRAM at **$00390650** in the captured setup. The physical address **$04000650** instead names SP memory. Before translation was connected, the model loader read the wrong bytes and called its own fatal error routine: `proc_dynlist() not a valid dyn list`. A plausible logo and successful short startup tests had not exercised that mapped access.

The adapter now applies page-size masks, ASID/global matching, validity and write permission before a physical access. Address, TLB miss/invalid and modification faults enter the guest exception path with the appropriate EPC/delay-slot state. Small CPU-only instruction fixtures explicitly retain a physical-memory contract; an N64 system always enables virtual addressing. Extended virtual addresses and complete hardware timing remain outside the current contract.

## Sampling a cached controller request

The operating system writes a Joybus request packet once, then reuses it for later read-only SI transfers. Refreshing buttons only when a new packet is written freezes the game at its first input state. [`serial.ts`](../../../../systems/n64/serial.ts) retains the controller-response location and refreshes it at every SI read completion. The input callback runs at that sampling point; the controller packet and poll count survive checkpoints. The [original `osContStartReadData`](https://github.com/n64decomp/sm64/blob/master/lib/src/osContStartReadData.c) shows why a packet write is optional on subsequent reads.

The regression changes Start/A and signed stick values between reads without another request write, then repeats the same checks after independent restoration. This verifies live controller traffic rather than only a successful device-identification response. PIF/CIC firmware execution remains outside the declared startup fixture.

## The current boundary

The bounded CPU startup study stops at the original request to clear the RSP's HALT flag, preserving the exact command. Separate RSP studies verify the [first audio task](AUDIO.md) and [graphics tasks](GRAPHICS.md). A later captured title-to-opening route also passes static CPU/RSP replay for its recorded source fingerprint, as described in [Startup](STARTUP.md). These are distinct verification scopes. Pixel precision is approximate and browser gameplay remains unfinished.

The work-in-progress [`N64Player`](../../../../systems/n64/player.ts) runs static CPU/RSP functions. Its [`worker host`](../../../../systems/n64/web/worker.ts) keeps execution separate from browser presentation and receives controller input through the system endpoint. A diagnostic package has reached Mario control and checked movement/jump/punch, but roughly 0.8–2 frames per second is too slow for playable acceptance. Current-source replay, sound, saving, rendering and wider progression remain unfinished.

## Waiting without losing time

The operating system's idle thread uses a self-branch and an empty delay slot:

```asm
BEQ $0, $0, -1
NOP
```

This loop changes no registers or memory. The runtime can summarize several iterations exactly, including retired instruction count and branch-delay phase. It verifies both instruction words every time and stops at the next Count/Compare, DMA, PCM, VI or RSP event. Interrupt acceptance still uses the original guest handler. Device comparisons check the coalesced execution against individual instructions; this is an execution optimization, not a substituted operating-system routine or a timing-accuracy claim.

Complete checkpoints retain CPU/FPU/TLB state, RSP lanes/accumulators/divider state, pending DMA/PCM/controller operations, display/TMEM/hidden memory and clock phases. RDRAM and SP bytes are stored separately. If a debugger stops the RSP after the CPU and devices advanced, the checkpoint also records the pending RSP instruction. Resume completes that same tick before retiring another CPU instruction.

## Preserving exact arithmetic while improving speed

The RSP's vector accumulator is a signed 48-bit integer, although JavaScript bitwise operators truncate to 32 bits. The backend stores each lane in a `Float64Array`: every modeled integer intermediate stays below JavaScript's 53-bit exact-integer limit. Explicit wrap, slice and saturation operations preserve the original 48-bit rules. This is exact integer representation, not approximate floating-point audio or graphics arithmetic. Checkpoints keep the same 12-digit hexadecimal accumulator values as before.

An independent BigInt oracle checks wrap and saturation across mixed multiply/accumulate operations. Mixed vector-operation comparisons and all three original-media SM64 integration tests also passed. Those checks support the arithmetic change; they do not establish whole-machine hardware accuracy or acceptable game speed.

## Grouping private RSP work

The static RSP program can preflight a short linear span of original instruction functions. It permits register and private-DMEM operations and stops before branches, device/control accesses, BREAK and unsupported operations. This is dispatch grouping, not a replacement graphics or audio routine; the original instruction functions still execute.

The N64 machine uses a span only while the CPU is in the guarded RDRAM idle loop and the whole span fits strictly before the next observable device event. Count/Compare, PI/SI/SP DMA, PCM and VI deadlines bound the interval. No other device observes the grouped register/private-DMEM changes inside that interval. Instruction counters and branch/clock phase still agree at its end. Debugger instruction stepping must use ordinary execution rather than coalescing past its stop.

Synthetic comparisons cover clock phases and interrupt/DMA boundaries. A separate 20-million-tick check from the captured title reached FullSync 136 with identical processors, devices, RDRAM and SP memory; 3,413,996 RSP instructions used spans. The local run measured about 20% faster, under concurrent analysis load. It is bounded state/performance evidence, not a browser FPS measurement or complete gameplay acceptance. The longer original/static menu replay is checked separately. See [project status](../../../../../docs/PROJECT-STATUS.md).

The supplied EU image first submits **task type 2: audio**. The CPU study reaches that request after 11,379,507 retired instructions, 50 interrupt entries and one guest CP1 exception in the current functional model. It completes 42 cartridge DMA transfers. AI consumes 160 priming PCM frames before this boundary; that does not mean the original game music is working. The full evidence is generated at `dist/work/games/n64/sm64/analysis/startup/report.json`.

The functional clock assigns one tick per CPU instruction. PI/SP/SI transfer work, VI divisors and AI PCM consumption are modeled, but cache, pipeline, cartridge bus and asynchronous device timing have not been verified against hardware. The initial fixture also bypasses IPL3/PIF/CIC boot. See [Startup](STARTUP.md) for the declared inputs and verification scope.

References: [NEC VR4300 manual](https://hack64.net/docs/VR43XX.pdf), the matching [SM64 main-thread source](https://github.com/n64decomp/sm64/blob/master/src/game/main.c), and primary [Libdragon Joybus](https://github.com/DragonMinded/libdragon/blob/trunk/include/joybus.h), [DMA](https://github.com/DragonMinded/libdragon/blob/trunk/src/dma.c) and [audio](https://github.com/DragonMinded/libdragon/blob/trunk/src/audio.c) interfaces. ROM Studio implements its own execution and device services.
