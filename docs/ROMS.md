# Original game media

| Game                              | Local directory      | Required input                                 | Recipe                                          |
| --------------------------------- | -------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Lemmings, Alpha Flight            | `roms/c64/lemmings/` | `LEMMING0.D64`, `LEMMING1.D64`, `LEMMING2.D64` | [recipe](../src/games/c64/lemmings/recipe.json) |
| Nebulus / Tower Toppler, NFI US   | `roms/c64/nebulus/`  | `TOWERTOP.D64`                                 | [recipe](../src/games/c64/nebulus/recipe.json)  |
| Elite                             | `roms/c64/elite/`    | `ELITE-E.D64`                                  | [recipe](../src/games/c64/elite/recipe.json)    |
| Super Mario Bros.                 | `roms/nes/smb/`      | `pal-sm-0 prg`, `hvc-sm-0 chr`                 | [recipe](../src/games/nes/smb/recipe.json)      |
| Tetris                            | `roms/nes/testris/`  | `pal-ei-0 prg`, `nes-ei-0 chr`                 | [recipe](../src/games/nes/tetris/recipe.json)   |
| Super Mario 64, Europe revision 0 | `roms/n64/sm64/`     | `nus-nsmp-0.u1`                                | [recipe](../src/games/n64/sm64/recipe.json)     |

The supplied `testris` directory spelling is retained. Raw PRG and CHR chips have no cartridge header; their recipe explicitly declares board wiring and timing. A different release stops a pinned build even if renamed. Retain supplied release notes as evidence.

A **ROM** is read-only memory. A ROM image is a binary dump of that memory, often cartridge program or graphics chips. A D64 is a binary disk image rather than a ROM chip. ROM Studio accepts both kinds of source media; identifying a file does not establish that the entire game is supported.

Start with `npm run cli -- identify roms`. This hashes and inspects the inputs without executing them. Source media remain under ignored `roms/`; game recipes and implementations live under `src/games/`. Generated data live under `dist/`.

The static build includes required media at `assets/roms/<sha256>.<role>.bin` and records their identity in its manifest. Identical media have stable identities. `dist/site/` is the deployment unit; `dist/work/` contains local traces and scratch evidence and is not deployed. Building does not publish a site.

## Nintendo 64 target

[Super Mario 64 — Europe](../src/games/n64/sm64/README.md) uses `roms/n64/sm64/nus-nsmp-0.u1`. Its recipe pins the raw 8 MiB, 16-bit byte-swapped image and records the normalized big-endian hashes separately. The original file is never rewritten to change byte order. See [N64 architecture work](systems/n64/README.md).
