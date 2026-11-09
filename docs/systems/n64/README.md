# Nintendo 64

The first target is [Super Mario 64, European revision 0](../../../src/games/n64/sm64/README.md). N64 cartridge identification handles big-endian, byte-swapped 16-bit and word-swapped 32-bit dumps, while retaining the original byte identity.

N64 needs its own backend: the VR4300 uses MIPS instructions and 64-bit registers, with branch delay slots and floating-point state. Graphics and sound also involve the RSP, RDP and device interfaces. The C64/NES instruction backend cannot execute this code.

The implementation keeps original MIPS translation separate from machine services, game knowledge and web presentation. The [CPU chapter](../../../src/games/n64/sm64/docs/CPU.md) explains these layers and CPU virtual versus physical device/DMA addresses. Bounded [audio](../../../src/games/n64/sm64/docs/AUDIO.md) and [graphics](../../../src/games/n64/sm64/docs/GRAPHICS.md) studies have static replay checks. Later execution reaches Peach's opening scene; a title-to-opening replay also passed for its captured source fingerprint. Pixel precision remains approximate. The N64 player/worker is in progress and browser play has not passed acceptance. Ordinary controls, sound, saving, performance and progression remain release work. See [current status](../../PROJECT-STATUS.md).

Diagnostic browser execution now reaches actual Mario movement, jumping and punching outside the castle. Earlier measurements were around 0.8–2 frames per second; the owner subsequently reported roughly 4 FPS. Full-speed browser execution remains the target, and performance is still a blocker. The machine described here is the N64 **reference tier**: original CPU and RSP instructions, per-tick device references and the software RDP. It remains the verification baseline for Learn and ROM Desk. Since 9 November 2026 full speed is pursued through a separate **play tier**; its first part runs Fast3D graphics tasks at a high level and draws in a parallel RDP worker. It keeps the recovered game code but may run recognized RSP microcode through high-level implementations, draw on a parallel worker or the GPU, and batch scheduling. Play-tier results must match the reference tier on recorded routes; see [Architecture](../../ARCHITECTURE.md#execution-tiers). A faster synthetic benchmark alone does not establish a playable game. The [performance chapter](../../../src/games/n64/sm64/docs/PERFORMANCE.md) explains costs, compiler changes and measurement scopes. The latest acceptance record is linked above.

Primary references:

- [NEC VR4300/VR4305/VR4310 user manual](https://hack64.net/docs/VR43XX.pdf).
- [Super Mario 64 matching decompilation](https://github.com/n64decomp/sm64), including its European identity, entry code and ROM layout.
- [Libdragon's cartridge writer](https://github.com/DragonMinded/libdragon/blob/trunk/tools/n64tool.c) documents header offsets and cartridge tooling. ROM Studio does not use it as an execution engine.
