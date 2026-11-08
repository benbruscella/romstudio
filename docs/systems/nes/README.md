# NES system profile

The first NES targets use the PAL Ricoh 2A07 CPU and PPU timing. They share the 6502 instruction translator with the C64, while memory, video, cartridge wiring, input and interrupt delivery live in a separate NES bus.

| CPU address   | Device                                   |
| ------------- | ---------------------------------------- |
| `$0000–$1FFF` | 2 KiB RAM and mirrors                    |
| `$2000–$3FFF` | PPU ports and mirrors                    |
| `$4000–$4017` | Audio registers, OAM DMA and controllers |
| `$6000–$7FFF` | Cartridge RAM in these board profiles    |
| `$8000–$FFFF` | Cartridge PRG mapping and mapper writes  |

The backend includes NROM and MMC1, CHR banking, nametable mirroring, PPU scroll/address latches, tiles, sprites, palette memory, sprite priority/zero hit, PAL vblank NMI, serial pads and OAM DMA. The CPU keeps its D flag but performs binary arithmetic even when it is set. Digital colors are a preview, not analogue video decoding.

Synthetic tests cover independent small hardware fixtures. Original/static replay verifies the supplied [SMB](../../../src/games/nes/smb/README.md) and [Tetris](../../../src/games/nes/tetris/README.md) routes. Neither constitutes full machine parity.

The [PAL 2A07 audio model](AUDIO.md) implements pulse, triangle, noise, DMC, frame sequencing and host-rate PCM output. CPU bus integration includes IRQs and DMC reads/stalls. Unit fixtures cover the channels, clocks and bus effects. Each game build compares original/static PCM per video frame alongside machine state, controllers and pixels. [Project status](../../PROJECT-STATUS.md) records the current game and browser acceptance evidence. The game chapters explain observed sound-driver instructions separately from the shared hardware.

Precise PPU fetch phases, reset/OAM/sprite-overflow quirks, fine DMC/OAM arbitration and independent audiovisual fidelity remain incomplete or unverified. The media parser must reject unsupported launch features rather than silently claiming compatibility.
