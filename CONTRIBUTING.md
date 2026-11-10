# Contributing to ROM Studio

Help turn original game binaries into understandable, verifiable game studies and static browser builds. Read the [release scope and decisions](docs/RELEASES.md), [architecture](docs/ARCHITECTURE.md), [educational standard](docs/INSPIRATION.md) and [current status](docs/PROJECT-STATUS.md) first. v0.1 includes six excellent games and the ROM Desk workbench.

## Set up

```sh
nvm install
nvm use
npm ci
npm run check
npm test -- unit
npm run cli -- identify roms
npm run dev
```

Use the Node version pinned in `.nvmrc` (currently 26.13.0). Original game media are local inputs under `roms/`; they are not included in the source repository. Generated game bytes and all analysis output belong under ignored `dist/`. Synthetic tests must work without private media. Use `npm test` for integration tests, including game verification, when you have the pinned inputs.

## Add a game

1. **Identify the bytes.** Run `roms identify <file-or-folder>`. Record SHA-256, release notes, format, entry vectors/load address and evidence for the system. A raw chip filename does not establish its board wiring.
2. **Create `src/games/<system>/<game>/recipe.json`.** Pin every source hash and media role/order; specify system, timing, local media directory and reviewed launch settings. See the existing [C64](src/games/c64/nebulus/recipe.json), [NES](src/games/nes/smb/recipe.json) and [N64](src/games/n64/sm64/recipe.json) recipes. Recognition is separate from playability. Byte-order normalization retains a separate original identity.
3. **Recover startup.** Put bounded analysis in the game's `recovery/` folder. Reuse system buses and the shared transpiler. Record gaps, unknown memory, unpacking writes, disk requests, input and declared launch fixtures. Preserve original files.
4. **Verify the emitted program.** Compare original instruction execution with static replay from the same launch. Include CPU, memory, device, input and visual evidence. Add realistic user sequences, held/released controls and failure regressions, not just one successful demo.
5. **Explain the game.** Add a short game README and chapters under its `docs/`. Keep source addresses with named routines under `code/`. Distinguish observed behavior, checked interpretation and hypotheses. Explain the main loop and memory map before claiming the game is an educationally complete study.
6. **Add the browser adapter.** `web/title.ts` supplies labels, actions, help, display timing and a player adapter. Shared browser code belongs in `src/web/`; machine wiring belongs in `src/systems/<system>/`. Game rules continue to come from the original instructions.
7. **Register a builder.** Add the game to the Node composition root in `src/titles.ts`, using the common `packageWeb` contract. Supply only the hardware modules this system needs. The library must label installed games without a verified package honestly.
8. **Check Play Game and Learn.** Verify the direct history URL, refresh, Back/Forward, keyboard, touch, sound where implemented, restart and the checked example. Record meaningful limits and update the status document.

A new game does not need empty folders for every possible layer. Add files when they have a purpose. Game-specific tests live next to the code; real-media cases use `*.integration.test.ts`.

A verified source study can exist before its browser player is accepted, as SM64 demonstrates. A read-only source package declares `playable: false`; an executable `partial-title` package may declare `playable: true`, but that field only means it can execute. Release readiness is a separate acceptance decision. Preserve the study's bounded verification scope and provide useful Learn material. Neither package satisfies a release requirement for a completed game. Keep the decoder/compiler in Node tooling and emit static source-address functions for browser execution.

## Add a system or hardware feature

Implement a media reader, the correct CPU variant, address map, devices, timing and browser dependency profile. Reuse existing ISA code when appropriate. Test hardware rules independently with small synthetic programs and fixtures. Existing C64 and NES implementations show how common CPU semantics can coexist with different devices.

Keep fixes at their actual boundary. Nebulus' doorway alignment belonged to VIC-II fine scrolling, not an artificial player-position change. A game's loader or release trainer belongs to that game until evidence establishes a reusable contract. No external emulator backend or fallback is part of ROM Studio.

Performance changes need controlled measurements and unchanged-output comparisons. Avoid adding hardware abstractions without evidence that they improve actual play.

Know which [execution tier](docs/ARCHITECTURE.md#execution-tiers) a change belongs to. Reference-tier changes must keep original instruction boundaries and tick-identical replay. Play-tier changes may implement system work, such as recognized N64 microcode, at a higher level or on the GPU. They must keep the recovered game code, never encode game rules and pass comparisons against the reference tier. Emscripten is the one excluded technology.

## Review checklist

- The behavior and its evidence are explained; uncertainty is labelled.
- Commands and local documentation links work.
- Generated output, media and machine-specific caches are not source files.
- Appropriate tests pass; unsupported paths remain visible.
- Shared abstractions are motivated by actual games/systems.
- The README stays a short user entry point; advanced recovery lives in CLI and game docs.

Repository: [benbruscella/romstudio](https://github.com/benbruscella/romstudio). v0.1 requires the owner's review and explicit approval before pushing or deploying. Preparing a build does not grant that approval.

## Readable source and automated checks

All maintained JavaScript uses `.js` with `"type": "module"` in package.json. TypeScript compiles to those modules. Prettier formats source, docs and configuration; ESLint checks correctness and requires braces around control-flow bodies. Generated game translations and all of dist are excluded from formatting and linting.

```sh
npm run fix
npm run check
npm test -- unit
npm test -- integration
```

`check` runs formatting verification, ESLint and TypeScript. Use clear names, short statements and comments explaining the original machine contract; a formatter cannot supply that explanation.

Pull requests are verified before merge; merges to main deploy. See [CI and deployment](docs/BUILD.md#ci-pull-requests-and-main).

The lockfile pins the development tools’ minimatch dependency to version 11.0.5 through an override. Keep format/lint/type checks passing when updating it. It is not shipped in game browser bundles.

A successful replay marks a route as checked, not a game as release-ready. Keep `build.status` as `partial-title` while ordinary play, sustained idle behavior or supported control paths still have known gaps. The library shows these as **Experimental study / Try study**. Reserve `release-ready` for an explicitly documented scope with normal controls, sustained play, restart and outcomes verified; passing one example cannot promote that status.
