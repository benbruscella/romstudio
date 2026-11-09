# Documentation

Start with the [project README](../README.md), [CLI](CLI.md) and [architecture](ARCHITECTURE.md).

The README states the mission; Releases is the durable scope/decision record; Inspiration credits influences; the specification defines technical behavior; architecture explains the code boundaries. Project status records current evidence and unfinished implementation. Game chapters explain individual routines and fixtures, and Blue sky contains future ideas. A historical passing check does not certify a newer working tree.

| Guide                                     | What it answers                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Releases and decisions](RELEASES.md)     | Committed v0.1 scope: six games and the workbench; execution tiers; retained project memory    |
| [Specification](SPEC.md)                  | What ROM Studio is trying to achieve and how support is judged                                 |
| [Project status](PROJECT-STATUS.md)       | Implementation progress, recorded evidence and unfinished acceptance checks                    |
| [CLI](CLI.md)                             | How to identify media, run the library and inspect assembly                                    |
| [Build and deployment](BUILD.md)          | What goes in dist and how to prepare GitHub Pages                                              |
| [Media inputs](ROMS.md)                   | Which original disks or chips each game needs                                                  |
| [Inspiration and credits](INSPIRATION.md) | Contra, RetroRecomp, MAMEKIT and cheviman's recovery/browser projects; lessons and differences |
| [Blue sky](BLUESKY.md)                    | Ideas beyond the core workbench: time travel, community remixes and advanced exploration       |
| [Contributing](../CONTRIBUTING.md)        | How to add games, systems and evidence                                                         |
| [NMOS decimal arithmetic](CPU-DECIMAL.md) | CPU behavior shared by the C64 games                                                           |
| [NES hardware](systems/nes/README.md)     | Cartridge boards, PPU, input and PAL timing                                                    |
| [N64 backend](systems/n64/README.md)      | VR4300 startup, RSP audio, textured graphics studies and remaining browser/player work         |
| [C64 audio](systems/c64/AUDIO.md)         | SID synthesis, validation and remaining limits                                                 |
| [NES audio](systems/nes/AUDIO.md)         | Original sound drivers, PAL APU timing, PCM replay and remaining limits                        |

Game-specific explanations live with their source: [Lemmings](../src/games/c64/lemmings/README.md), [Nebulus](../src/games/c64/nebulus/README.md), [Elite](../src/games/c64/elite/README.md), [Super Mario Bros.](../src/games/nes/smb/README.md), [Tetris](../src/games/nes/tetris/README.md), and [Super Mario 64](../src/games/n64/sm64/README.md). This avoids a second game hierarchy in docs. Code, tests, recipes and explanations can be reviewed together.

[Review v0.1 locally](TESTING.md) provides the game controls and release checklist.
