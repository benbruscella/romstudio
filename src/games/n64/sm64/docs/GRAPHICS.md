# From microcode to framebuffer writes

The CPU prepares a graphics task and display list. The **RSP** runs the cartridge's original Fast3D microcode, transforms that list into hardware commands and transfers them to RDRAM. The **RDP** consumes those commands and writes pixels. The **VI** selects memory for display. Each stage has its own state and responsibility.

| Layer                     | What runs here                                                               | Source                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Game and operating system | Original CPU instructions create and schedule tasks                          | CPU assembly → TypeScript                                                                                          |
| Fast3D microcode          | Original RSP instructions prepare hardware commands                          | RSP graphics assembly → TypeScript                                                                                 |
| RDP hardware model        | FIFO, tile descriptors, texture memory, fill pixels and completion interrupt | [`systems/n64/display.ts`](../../../../systems/n64/display.ts), [`texture.ts`](../../../../systems/n64/texture.ts) |
| Web presentation          | Chapters, source selection, canvas and input controls                        | [`web/`](../../../../web/)                                                                                         |

The TypeScript renderer implements hardware operations. Geometry, game rules and task submission remain in the original instructions. Browser presentation is a separate layer.

This chapter describes the **reference tier**, which Learn and ROM Desk use. The **play tier** keeps the game's task submission and rules but runs [`fast3d.ts`](../../../../systems/n64/fast3d.ts), a ROM Studio TypeScript implementation of the recognized Fast3D microcode, instead of its original RSP instructions. It feeds the same software RDP, in a parallel browser worker, so its frames compare directly with this path; [performance](PERFORMANCE.md#play-tier-first-implementation-9-november) records the comparison. See [execution tiers](../../../../../docs/ARCHITECTURE.md#execution-tiers). The worker player has reached original menus and live Mario controls; full-speed play, usable sound and wider progression remain unaccepted.

## Reproduce the first graphics study

```sh
npm run cli -- boot --title sm64 --until graphics
```

This longer recovery can take several minutes. It first verifies CPU startup and the first audio task, then continues original CPU/RSP execution through controller and EEPROM initialization. It captures the exact first graphics handoff, retaining scalar/vector registers, accumulators, SP registers/DMA, memories and RDP state. The CPU is paused immediately inside the start callback, before the first graphics RSP instruction. Its status write has not retired yet.

The isolated graphics task executes **4,449 RSP instructions** across **267 observed address/word shapes** in the current functional model. It clears the depth buffer and a 320 × 240 framebuffer, including the two border rows, then signals completion. Seven checks compare original-word execution with fresh static replay: RSP state, all RDRAM/SP bytes, device/clock state, both completion interrupts, command consumption and buffer writes.

The report and captured inputs live at `dist/work/games/n64/sm64/analysis/graphics/`. The generated source package is under `analysis/startup/source-study/`, with the additional microcode in `game-code/rsp-graphics/`. A library assembled from a package containing these sources exposes `/n64/sm64/learn/code-rsp-graphics`; running a boot capture alone does not update an existing library.

## What the renderer supports

[`display.ts`](../../../../systems/n64/display.ts) implements functional FIFO setup/freeze, synchronization, retained mode/combiner/depth state, integer scissoring, and fill-cycle RGBA16/RGBA32 rectangles. Fill endpoints are inclusive; scissor endpoints are exclusive. RGBA16 fill colors contain two packed pixels, selected by their position within a RDRAM word. Independent fixtures check clipping, odd framebuffer widths, nonzero packed colors, single-column rectangles, guard pixels and pending FIFO checkpoint restoration.

`FullSync` raises the DP interrupt observed by the original operating system. Unknown commands stop at their source address without advancing past unexecuted work. FIFO parsing also waits for complete multiword packets: a shaded, textured triangle with depth coefficients occupies 176 bytes, and coefficient words must never be mistaken for separate commands.

## Follow the first texture and vertex calculations

```sh
npm run cli -- boot --title sm64 --until textures
```

This continues the original CPU/RSP path past the buffer clears and captures the first textured graphics task. In a paused-CPU fixture its prefix executes **8,602 RSP instructions** across **920 observed address/word shapes**. It loads the first 32 × 32 RGBA16 texture and prepares a complete shaded/textured/depth triangle. This earlier study deliberately stops at a draw breakpoint and reports `first-textured-triangle-reached`, with `taskComplete: false`. The separate rendered-task study below continues through the triangle pixels.

Seven checks compare the original words and emitted static functions at that same boundary: RSP state, RDRAM, SP memory, devices, the triangle packet, all **1,024 texture samples** and the fact that the breakpoint leaves the triangle unconsumed. The independent texture expectation decodes the original RDRAM image directly, bypassing TMEM addressing. This checks every odd and even row, rather than accepting a plausible-looking image.

Outputs are in `dist/work/games/n64/sm64/analysis/textures/`, including `first-texture.png`, the exact captured task inputs and a report containing the unrendered triangle's bytes. Generated source is under `game-code/rsp-textures/`; Learn exposes `/n64/sm64/learn/code-rsp-textures`. The earlier clear-task source remains available separately.

Microcode DMA can replace instructions at the same IMEM address. In this prefix `$000` holds both the initial jump and a later `VRCPH`. Learn retains both address/word variants: filtering an address narrows the list, then selecting the actual instruction chooses its matching TypeScript function. This preserves observed variants; a complete DMA/write-epoch trace is still unfinished.

The important instructions and hardware responsibilities are:

| Operation                 | Purpose                                                                                                                       | Implementation                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `VCH` followed by `VCL`   | Compare transformed coordinates against clipping bounds, preserving sign/equality information between the high and low halves | [`rsp-vector.ts`](../../../../runtime/rsp-vector.ts)                                          |
| `VRCPH` / `VRCPL`         | Assemble a 32-bit input, calculate the RSP's reciprocal approximation, and retrieve its result halves                         | [`rsp-reciprocal.ts`](../../../../runtime/rsp-reciprocal.ts), divider latches in vector state |
| `LUV`                     | Expand eight packed color bytes into unsigned fixed-point vector lanes                                                        | [`rsp.ts`](../../../../runtime/rsp.ts)                                                        |
| `SetTile` / `SetTileSize` | Select the texture format, row stride, bounds, masks, shifts and mirroring                                                    | [`texture.ts`](../../../../systems/n64/texture.ts)                                            |
| `LoadBlock`               | Move image bytes into 4 KiB TMEM, using DXT to exchange 32-bit banks on odd rows                                              | The same texture hardware service                                                             |

These are hardware instructions executed by original Fast3D microcode. They are separate from recovered game-level names and from browser presentation. Reciprocal output uses the RSP's normalized ROM approximation, including its negative-input quirks, rather than JavaScript's floating-point division. Pending input and previous output are retained in checkpoints. Clip tests include minus-one boundaries, unsigned fractional halves and signed 32-bit comparisons.

Texture loading currently supports matching 8/16-bit load sizes, zero S/T origin and an aligned source; other cases stop explicitly. Sampling decodes RGBA16, IA16/8/4 and I8/4 with origin, shift, wrap, mirror and clamp handling. Packed RSP loads/stores cover aligned `LPV`/`LUV`/`SPV`/`SUV` with byte element zero; remaining forms stop explicitly. CI/TLUT, RGBA32 texture banking, YUV, mipmapping and fractional/interlaced scissoring remain unfinished.

Later title-screen work uses `LTV`/`STV` transpose transfers across eight-register groups and reciprocal square root for vector calculations. Transpose loads and stores have different element/alignment rules; the tests retain explicit expected bytes and verify neighboring registers and DMEM wrap. The square-root significands are reconstructed by exact integer comparisons and match all 512 entries in the published RSP ROM data. `VRCPH`/`VRSQH` and their low-half operations share the same input/output latches; mixed-pair tests use values reported by the physical-console test suite. These operations implement processor behavior, with game decisions remaining in the original microcode.

## Draw the original task

```sh
npm run cli -- boot --title sm64 --until frame
```

The original task now completes **373,418 RSP instructions** across **953 observed address/word shapes**, sends **282 triangles**, writes framebuffer/depth pixels and signals its own completion. Its first logo-animation frame is tiny: only 16 nonblack pixels. Later exploratory CPU/RSP execution produces the recognizable expanding Super Mario 64 logo, Mario's title-screen head and nonzero audio samples. The title image has visible raster/lighting artifacts. These later frames and audio are additional recovery evidence, separate from the isolated task's static replay.

The rendered-task report has seven checks for RSP state, RDRAM, SP memory, devices, RGBA pixels, completion interrupts and actual color/depth writes. `dist/work/games/n64/sm64/analysis/render/first-frame.png` is the first color-image capture. Learn's `/n64/sm64/learn/code-rsp-render` contains the original microcode and emitted TypeScript. Clear-task and texture-prefix sources remain separate and available.

| Hardware stage         | Code                                                         | What it does                                                                                 |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Packet decoding        | [`rdp-triangle.ts`](../../../../systems/n64/rdp-triangle.ts) | Reassembles split 16.16 coefficient fields into screen edges, color/texture planes and depth |
| Rasterization          | The same module                                              | Walks the major and minor edges, clips spans, counts subpixel coverage and steps attributes  |
| Texture sampling       | [`texture.ts`](../../../../systems/n64/texture.ts)           | Fetches TMEM texels and applies the RDP's three-point filter                                 |
| Color/depth processing | [`rdp-pixels.ts`](../../../../systems/n64/rdp-pixels.ts)     | Evaluates color/alpha muxes, perspective coordinates, depth comparisons, blending and writes |
| Buffer inspection      | [`render.ts`](../../../../systems/n64/render.ts)             | Converts a color image to opaque RGBA; VI scanout/filtering is a separate concern            |

The edge packet does not contain three ordinary vertex structures. The RSP already calculated three edge positions/slopes and interpolation coefficients. `dx` describes change across a scanline, `de` describes change along the major edge, and `dy` supplies the subpixel vertical correction. The renderer consumes these values; it does not recreate Mario's geometry or substitute game rules.

The combiner evaluates `(A - B) × C + D` independently for RGB and alpha. Its inputs come from texture, interpolated shade and programmable colors. Depth uses Nintendo's compressed exponent/mantissa format, with depth-delta and coverage information in hidden RDRAM bits. These hidden bits are checkpointed alongside ordinary machine state. One/two-cycle triangle drawing and point/filter texture rectangles are implemented, including copy-cycle horizontal stepping and flipped axes.

The software rasterizer derives an integer interval for each coverage sample on a scanline. An interior pixel belongs to every interval, so it can accept full coverage without repeating eight edge comparisons. Boundary pixels still count the original samples and evaluate their centroid. The texture filter still reads three taps; it computes the four neighboring S/T indices once and packs temporary colors to avoid extra arrays. [Coverage](../../../../systems/n64/rdp-triangle.test.ts) and [texture](../../../../systems/n64/texture.test.ts) comparisons check these paths against independent scalar evaluation. These execution optimizations preserve the current renderer's output and do not claim greater hardware precision.

The active software draw path also reuses an [`RdpSpan`](../../../../systems/n64/rdp-triangle.ts) buffer for each scanline. [`rdp-span-pixels.ts`](../../../../systems/n64/rdp-span-pixels.ts) prepares command-constant render state, while [`rdp-combiner.ts`](../../../../systems/n64/rdp-combiner.ts) resolves mux selectors into reusable scratch registers. The packed texture fetcher chooses a format once per draw. Pixel processing allocates no fragment objects or RGBA tuples. The original scalar writer/sampler APIs remain references, with [scanline/pixel comparisons](../../../../systems/n64/rdp-spans.test.ts) checking color, depth, hidden bits and failure boundaries. This is synchronous software rendering into the original RDRAM; it adds no deferred graphics backend.

Anti-aliased surfaces blend only where hardware does: without FORCE_BL, a pixel blends when its coverage plus memory coverage does not overflow and it is not clearly in front of the stored depth. A surface's first edge pixel over the background is written unblended with partial coverage, and a second triangle sharing that edge blends the two surface colors. Earlier versions blended every partial pixel, which let the background show through interior seams as outlines. The video interface's later silhouette smoothing is not yet modeled.

The report labels pixel precision **functional-approximation**. Ideal perspective division, subpixel centroid selection, blend/coverage rounding, depth correlation and missing dithering are not independent bit-exact hardware matches. Zero or negative perspective W produces saturated coordinates rather than stopping; this behavior is backed by [physical-hardware observations](https://github.com/carmiker/n64docs/blob/master/RDP_TESTCART_HARDWARE.txt). The finite quotient still differs from the RDP's reciprocal lookup implementation. Unsupported combiner inputs and texture/LOD formats stop explicitly. A drawn logo does not establish playable Mario or satisfy the six-game release requirement.

## Verification scope

These graphics commands use exploratory CPU captures followed by isolated static RSP comparisons. They do not check a continuous CPU replay from the first audio request through the first graphics handoff. Other devices use fresh defaults while the CPU is paused, and the device clock restarts for each isolated study. A separate later [title-to-opening route](STARTUP.md) has CPU/RSP static replay for its recorded source fingerprint; it starts at the title checkpoint and does not change the scope of these earlier fixtures. Neither establishes hardware parity, console reset, complete audio or playable Mario. The N64 worker host exists but browser acceptance remains unfinished.

References: [SGI's RSP instruction and FIFO documentation](https://ultra64.ca/files/documentation/silicon-graphics/SGI_Nintendo_64_RSP_Programmers_Guide.pdf), [SGI's RDP Command Summary](https://hcs64.com/files/RDP_COMMANDS.pdf), [Nintendo's TMEM description](https://ultra64.ca/files/documentation/online-manuals/man/pro-man/pro13/13-08.html), original [graphics command fields](https://github.com/n64decomp/sm64/blob/master/include/PR/gbi.h) and recovered [SM64 graphics initialization](https://github.com/n64decomp/sm64/blob/master/src/game/game_init.c). The [RSP research notes](https://github.com/Dillonb/n64-resources/blob/master/rsp.md) publish the reciprocal ROM data; the [hardware test ROM's clipping tests](https://github.com/lemmy-64/n64-systemtest/blob/main/src/tests/rsp/op_vector_arithmetic.rs), [divider tests](https://github.com/lemmy-64/n64-systemtest/blob/main/src/tests/rsp/op_vmov_vrcp.rs), [transpose loads](https://github.com/lemmy-64/n64-systemtest/blob/main/src/tests/rsp/op_vector_loads.rs) and [transpose stores](https://github.com/lemmy-64/n64-systemtest/blob/main/src/tests/rsp/op_vector_stores.rs) document edge behavior. They are behavioral references; ROM Studio runs its own implementation and does not embed an external emulator.
