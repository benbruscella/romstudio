# ROM Studio CLI

The command is **`roms`**. Identification is the starting point: find out what the bytes are before choosing a CPU, loader or game recipe.

## Run from the checkout

```sh
nvm install
nvm use
npm ci
npm run cli -- identify roms
```

The first `--` belongs to npm: it forwards the following arguments to ROM Studio. For example, `npm run cli -- identify roms/nes` runs the equivalent of `roms identify roms/nes`. The normal play/build commands have short npm scripts and need no knowledge of recovery internals.

To install the executable from this checkout:

```sh
npx tsc -p tsconfig.json
npm link
roms --help
```

`npm link` installs a local development link. It is optional; all examples also work through `npm run cli --`.

## 1. Identify original media

```sh
roms identify game.d64
roms identify game.nes
roms identify roms/nes
roms identify roms/n64/sm64
roms identify roms --json
```

The report includes byte length, SHA-256, format, system evidence and exact matches to pinned game recipes. D64 directories include their files; iNES headers include board and chip information. N64 reports include cartridge title/code/revision, byte order, entry point and a separate normalized hash; the input file remains unchanged. PRGs expose their load address and an optional supported BASIC SYS target.

A raw binary has no universal system identifier. A known PRG/CHR hash can identify an installed NES chip even if its filename changes. An unknown binary stays unknown. Identification never executes the input, modifies it, or promises that the game is playable. `--json` produces structured reports for scripts. `inspect` is retained as an alias for `identify`.

## 2. Run the library

```sh
npm run dev
npm run dev -- --port 4175
```

The default URL is `http://127.0.0.1:4170/`. Choose a system, then **Learn** or **Try study**. **Play Game** is reserved for release-ready entries. Game routes use the History API, such as `/c64/nebulus`. Back/Forward and direct links are part of the routing contract.

`dev` compiles the tools, builds every game package with the current code and assembles them into `dist/work/site/`; it rebuilds when source changes. An alternate port gets its own directory, for example `--port 4175` uses `dist/work/site-4175/`; `--out` overrides that choice. Packaging reuses each game's saved recovery capture rather than redoing a long recovery. A fresh checkout can browse Learn without original media. To play a game with no verified package, install its pinned media and build that game first. A busy port reports its URL and the option to choose another port.

## 3. Build games and a deployable site

```sh
npm run build
npm run build -- --base /romstudio/
npm run cli -- build-game n64/sm64
npm run cli -- verify-game n64/sm64
npm run cli -- preview
```

`build` packages every registered game with the current code, checks their manifests, includes hashed media and learning evidence, and writes `dist/site/` with experimental studies. `build-game` packages one game. Packaging reuses saved recovery captures; `verify-game` reruns one game's original recovery and original/static comparison and records the result, and `npm test` runs these for installed media. `--deploy`, used by CI, verifies every game (as `verify-game` does) instead of packaging from captures, excludes studies and rejects any required game that is unfinished or not verified for the current sources. `preview` serves the existing site using its configured base path.

### Selecting a platform version

Game selectors identify a platform version: `roms build-game nes/tetris` or `roms play --title c64/nebulus`. A short alias such as `tetris` works while it is unique. If another platform adds that name, use `nes/tetris` or `tetris --system nes`; an ambiguous name fails with the available choices. The same pair namespaces source, recovery output and learning material.

## Assembly tools

```sh
roms extract disk.d64 --out dist/work/extracted/disk
roms disassemble dist/work/extracted/disk/entry-000.prg
roms lift dist/work/extracted/disk/entry-000.prg --out dist/work/lifted
```

Extraction uses generated filenames and refuses to overwrite existing files. Disassembly follows reachable code; unresolved indirect control remains a gap. Lift emits TypeScript, JavaScript, source mappings, gap reports and CPU execution support. It does not automatically turn an arbitrary game into a complete web build. `--entry 0x080c` supplies a reviewed entry point; quote addresses such as `'$080c'` in the shell.

These generic assembly commands currently handle the 6502 PRG workflow. N64 MIPS/RSP recovery runs through its registered game builder and bounded `boot --title sm64` stages; generic disassembly does not infer an arbitrary CPU from a raw binary.

## Advanced recovery commands

These are development tools, not steps needed to play:

| Command                                   | Purpose                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `roms trial` / `roms verify`              | Check the synthetic Lemmings bootstrap fixture                                                                                               |
| `roms recover`                            | Follow the self-modifying unpacker to a bounded checkpoint                                                                                   |
| `roms boot --title nebulus`               | Execute original startup and verify the menu                                                                                                 |
| `roms boot --title sm64`                  | Verify CPU startup, then the first original RSP audio task and named mixer                                                                   |
| `roms boot --title sm64 --until graphics` | Continue original startup, capture its first graphics task and verify static RSP replay plus RDP buffer clears; takes several minutes        |
| `roms boot --title sm64 --until textures` | Verify first clear task and the later vertex/texture prefix, checking all 1,024 texels; stops before the first unrendered triangle           |
| `roms boot --title sm64 --until frame`    | Complete the first textured task, compare static replay and color/depth output, and write `first-frame.png`; browser play remains unfinished |
| `roms level --number 2`                   | Capture the second Lemmings level's data and first spawn                                                                                     |
| `roms dig`                                | Verify a complete original digger action against its named interpretation                                                                    |
| `roms play --title nebulus`               | Serve one verified game package directly                                                                                                     |

Recovery accepts `--media <directory>`, `--recipe <json>` and `--out <directory>`. Full details belong in each [game's documentation](../src/games/). These commands retain explicit fixtures and bounded coverage; they are not a claim of full machine parity.

SM64 boot studies write their generated source package beneath `analysis/startup/source-study/`, separate from the browser package. Producing a study does not automatically publish it into an existing library or validate the work-in-progress N64 worker player. See [build outputs](BUILD.md).

## npm scripts

| Script  | Purpose                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------- |
| `dev`   | Build every game package with the current code, serve the library, rebuild on change              |
| `build` | Build every game package and the static site; CI adds `--deploy`                                  |
| `test`  | Unit and local-media integration tests, including game verification (`-- unit`, `-- integration`) |
| `check` | Verify format, lint and types                                                                     |
| `fix`   | Apply Prettier formatting and ESLint fixes                                                        |
| `cli`   | Run any `roms` command from the checkout, such as `build-game`, `verify-game` or `preview`        |

Generated files belong under `dist/`. The old `.romkit/`, `exports/` and individual npm recovery scripts have been removed. `npm run level -- --number 2` is obsolete; use the advanced CLI only when doing that analysis.

## Pinned media for CI

`roms media bundle` creates `dist/work/rom-studio-media.json.gz` from exactly the current pinned game inputs. `roms media import <bundle.json.gz>` validates identities, bounded sizes and hashes before restoring the expected files under roms. It never takes extraction paths from the bundle or overwrites different existing bytes. [Build and CI setup](BUILD.md) explains the owner-approved release asset used after a merge to main.

`check` combines format verification, lint and types; `fix` applies the automatic formatting and lint fixes. Maintained JavaScript modules use `.js`, with package.json declaring `"type": "module"`; TypeScript compiles to those modules. The runtime version is pinned in `.nvmrc`.
