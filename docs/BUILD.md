# Build, preview and deployment

## Local workflow

```sh
nvm install
nvm use
npm ci
npm run cli -- identify roms
npm run dev
```

`dev` compiles tools, builds every game package with the current code, assembles them into `dist/work/site/` and serves the development library on loopback port 4170. If that port is in use, follow its diagnostic or choose `npm run dev -- --port 4175`. Alternate ports use their own output, such as `dist/work/site-4175/`, so separate servers do not overwrite one another's catalog/manifest. Rebuilds triggered during another watcher build are coalesced and run afterward. `--out` can explicitly select another directory. Keep the server running while testing; Ctrl-C stops it.

```sh
npm run build
npm run cli -- preview
npm run cli -- build-game n64/sm64
npm run cli -- verify-game n64/sm64
npm test
```

**Build packages; tests verify** ([decision](RELEASES.md#build-test-and-deploy--decided-9-november-2026)). `build` packages every game from its saved recovery capture with the current compiled code, then writes `dist/site/`, including experimental studies. `build-game` packages one game. `verify-game` reruns that game's original recovery and original/static comparison, records the result and refreshes its capture; `npm test` runs these verifications for games whose media are installed. Each package manifest records whether its verification passed for the sources it was built from. A capture is reused input, never evidence that changed code passed. `dist/` is disposable: on a clean checkout the first build creates whatever is missing. Games build in parallel child processes, printing a plan, prefixed progress, a heartbeat every 30 s and per-game timings. A game without a package or capture recovers once without the original/static comparison. SM64 keeps its recovery captures in git-ignored `.cache/captures/n64/sm64/`, outside `dist/`, so deleting `dist/` does not force its recovery; the C64/NES games recreate their packages from recovery. The C64 and NES games recover without the comparison during `build` (recorded as `not-run`) and reuse an existing package, unless its player files (shell, runtime, system and title modules, page, styles or Desk symbols) differ from the current code. Then `build` copies the changed files into the package and re-hashes its manifest in seconds, without rerunning recovery. A package that had passed verification becomes `stale`. If a changed module imports a file the package lacks, `build` rebuilds the package instead. `build --deploy` instead runs `verify-game` for every game in parallel, because CI starts with no packages or captures and deployment accepts only packages verified for the current sources.

## Output layout

| Directory     | Contents                                                                                  | Deploy? |
| ------------- | ----------------------------------------------------------------------------------------- | ------- |
| `dist/tools/` | Compiled Node tools and tests                                                             | No      |
| `dist/work/`  | Traces, checkpoints, analysis, local browser checks and verified game packages            | No      |
| `dist/site/`  | Library, Play/Learn views, HTML/JS/CSS, verified game modules, media assets and manifests | Yes     |

The old `.romkit/` and `exports/` directories have been migrated and removed. All generated output stays under `dist/`. Original source media stay in `roms/`. Neither original media nor generated commercial bytes are committed as project source.

Each game manifest declares delivered files and their SHA-256 hashes. The site builder verifies them before inclusion and copies required original media under hash filenames. It writes the site manifest last. The preview serves only declared, verified files and adopts a complete rebuilt package when the page is refreshed.

### Platform namespaces

Game packages and their recovery evidence live at `dist/work/games/<system>/<game>/`. The deployment keeps the same identity under `games/<system>/<game>/` and `learning/<system>/<game>.json`. Pinned media-bundle identities include both system and game; regenerate an older bundle after changing this layout. Source media still live at the recipe's declared path under `roms/`.

## romstud.io and GitHub Pages

The custom domain is **romstud.io**. Build for its root URL:

```sh
npm run build -- --deploy --domain romstud.io
npm run cli -- preview
```

This uses base `/` and includes a `CNAME` file for branch-based Pages publication. With an Actions Pages deployment, the custom domain is configured in repository settings; GitHub ignores the artifact's CNAME. Domain and DNS setup are separate from building the artifact. Follow [GitHub's custom-domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) when the release is approved. No DNS or repository settings are changed by the build.

For testing the repository URL before the custom domain is configured, use the project base:

Repository: [benbruscella/romstudio](https://github.com/benbruscella/romstudio).

```sh
npm run build -- --base /romstudio/
npm run cli -- preview
```

The deployment unit is the **contents of `dist/site/`**. Configure GitHub Pages to publish that static artifact. A project-path build uses `/romstudio/`, with game URLs such as `/romstudio/c64/nebulus`. The custom-domain build uses `/`, giving `https://romstud.io/c64/nebulus`. Navigation uses the History API. A generated [Pages 404 page](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site) redirects through the site's root and restores direct game and Learn links after a refresh, without hash routing.

A clean remote checkout does not contain the original media, so a remote source-only build cannot reproduce the games unless those inputs are deliberately supplied there. The locally verified site artifact already contains the assets needed to run. Tool binaries, recovery scratch output and original local paths are not part of that artifact.

Preparing a site is separate from publishing it. **v0.1 must be reviewed and explicitly approved by the owner before pushing or deploying.** No release or deployment is approved merely by running these commands.

## Verification

Use `npm run check`, `npm test -- unit` and `npm test -- integration`; the integration group includes game verification with installed media. [Project status](PROJECT-STATUS.md) records current runs and pending browser acceptance. Game chapters document bounded coverage and fixtures; internal replay is distinct from independent hardware parity.

Node on macOS ARM64 has crashed natively during large analyses; Bun has also crashed. On 9 November 2026 the native crash was traced to V8's concurrent Sparkplug compilation of the very large generated code: Node 26 still crashed with no flags, but `--no-concurrent-sparkplug` alone ran 200-million-tick SM64 workloads repeatedly at about 12 million ticks/s, versus 1.4 million with `--max-opt=1`. Scripts and analysis workers now pass only `--no-concurrent-sparkplug`, roughly eight times faster. A successful run does not establish that the host issue is universally resolved. Nebulus verification still crashed intermittently in JIT code on the main thread (`SIGSEGV`/`SIGBUS`) with only `--no-concurrent-sparkplug`: five of six runs on Node 24.22.1 and one of three on Node 26.12.1, including with Sparkplug or Maglev disabled. `--single-threaded` still crashed once in eight runs, so this is not a concurrency race any flag removes. An analysis process that dies from a native crash signal (`SIGSEGV`, `SIGBUS`, `SIGTRAP`, `SIGILL`) without reporting a result is therefore rerun with the same input, at most twice, and the rerun is printed. Its result is checked in full; errors, failed comparisons, time-outs and other exits still fail the build, and there is no emulator fallback or weaker check. The fault can also be silent: one SMB verification on Node 26 produced `mixed-directions` audio that differed from its static replay in three of 700 frames, with identical CPU state and pictures, and the comparison failed the build. The previous build of the same code passed SMB. Treat a failed comparison on macOS as possibly host-caused, but never accept it: rerun the verification. The CLI refuses to run on Node older than the `.nvmrc` major version; run `fnm use` or `nvm use` in the repository.

## CI: pull requests and main

`.github/workflows/check.yml` puts the full verification on pull requests, so problems show before merging:

| Event                                         | Jobs                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pull request from a branch in this repository | format/lint/types and unit tests, then the verified build (restore the sealed media, `npm run build -- --deploy --domain romstud.io`, which verifies all six games against their originals), then `npm test -- integration`, including ROM Desk stepping on the built packages |
| Pull request from a fork                      | format/lint/types and unit tests, plus a notice: forks cannot read `MEDIA_KEY`                                                                                                                                                                                                 |
| Merge to main                                 | format/lint/types and unit tests, the same verified build for the merged commit, then deployment                                                                                                                                                                               |

Main does not repeat the integration tests, which the pull request already ran on the same code. It does rebuild and verify, because the site publishes only packages verified for the exact merged commit. A failed check, hash or game replay prevents deployment. To require a manual approval for each deployment, add a required reviewer to the `github-pages` environment.

The custom domain is code: `PAGES_DOMAIN: romstud.io` in the workflow. Builds target its root (base `/`). Actions deployments ignore the artifact's `CNAME`, so before publishing, the deploy job sets the GitHub Pages custom domain to `PAGES_DOMAIN` if it differs. It uses the workflow token, or the optional secret `PAGES_ADMIN_TOKEN` if one exists. If the domain can't be set, the job stops before deploying and the previous site keeps working. After deploying, it turns on Enforce HTTPS once GitHub has issued the certificate, retrying on later deploys until then. DNS for the domain must point at GitHub Pages first (see below).

The original media are committed only in encrypted form: `ci/rom-studio-media.sealed`, an AES-256-GCM sealed copy of the pinned media bundle. Its key exists only as the repository's Actions secret `MEDIA_KEY`. CI opens it with `npm run cli -- media import ci/rom-studio-media.sealed`. Each identity and byte hash must match the current game recipes before any file is restored, and the importer refuses extra identities, changed existing files and extraction paths supplied by the archive. A missing sealed file, a missing key or a wrong key fails CI with an explicit error; it never substitutes different game bytes.

One command sets this up, and repeats it after a recipe changes. Run it on a machine that has `roms/` and a `gh` login with admin rights on the repository:

```sh
npm run cli -- deploy-setup
```

It seals the pinned inputs with a fresh key, verifies that the sealed file opens and matches every recipe hash, stores the key as `MEDIA_KEY`, and switches GitHub Pages to publish from GitHub Actions. Commit the new `ci/rom-studio-media.sealed` afterwards: the secret and the committed file must match. Before deploying, the workflow checks the Pages source and fails with this command in the error if Pages publishes from a branch.

### Pointing romstud.io at the site

DNS lives at the domain's DNS host, outside GitHub. It is in place for romstud.io:

1. The apex points at GitHub Pages: A records `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`. AAAA records `2606:50c0:8000::153` through `2606:50c0:8003::153` are optional. `www` is a CNAME to `benbruscella.github.io`. No other apex A, AAAA or ALIAS records. See [GitHub's custom-domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
2. Recommended: verify the domain for the account (GitHub profile → Settings → Pages → **Add a domain**, then the TXT record `_github-pages-challenge-benbruscella.romstud.io` it shows). This stops other accounts claiming it.
3. Check: `dig romstud.io +noall +answer` lists the four addresses. The workflow does the rest on the next merge to main.

## Executable studies and ready games

A game package may execute and pass recorded replays while still being an experimental recovery. The catalog records `runnable` separately from `experimental`; executable `partial-title` packages show **Try study**, never a ready-game count. `build.status: release-ready` is the owner's acceptance, with documented scope and limits. On 9 November 2026 the owner accepted all six games as working. Development assemblies can retain Learn evidence without interactive execution. `npm run dev` and `npm run build` include available executable studies; `--deploy` excludes them. A successful study build validates included files and declared routes, not complete games.

SM64's `boot` command writes read-only CPU/audio studies under `dist/work/games/n64/sm64/analysis/startup/source-study/`. `--until graphics`, `--until textures` and `--until frame` add the separate graphics views. These commands do not replace the canonical browser package or by themselves update an already assembled library. The separate SM64 browser builder and worker have bounded live-control checks but have not passed full browser acceptance. Its title-to-opening captures live under `.cache/captures/n64/sm64/playback/<fingerprint>/`. `build` packages from the capture whose verification matches the current sources, or otherwise from the newest passing capture for this cartridge, labelling the package's verification as stale. `verify-game n64/sm64` reruns recovery and the comparison for the current sources. An older successful replay cannot certify changed source.

New SM64 replay records include a versioned dependency snapshot. The build follows static local imports in both source TypeScript and emitted JavaScript, including literal dynamic imports, re-exports and worker module URLs; it hashes those files, configuration and tool versions. Cache reuse compares that snapshot and all declared capture hashes. The model is checked again after replay and around packaging, so editing a dependency during a long verification run invalidates the result.

The snapshot roots include the SM64 builder and N64 browser app/worker, so delivery changes also invalidate reuse. The active renderer is implemented in TypeScript, and the canonical local game remains the checked software package `1e4e4e29…`.

There are two explicit analysis-fixture modes. `titleFixtureFingerprint` supplies an earlier title launch and reruns current original/static execution from it. `replayFixtureFingerprint` instead compares newly generated current static execution with a complete earlier verified original endpoint, including every stereo sample and source rate. It requires the original endpoint, both memories and a passed original/static PCM check; a title-only capture is insufficient. The new record names that older reference and hashes all its files. Its check names and package scope state that original recovery was not rerun under the new source. Neither mode rechecks earlier startup or establishes hardware parity; earlier evidence is never retagged as a fresh original run. These are internal analysis options, not extra public CLI commands. See [performance verification](../src/games/n64/sm64/docs/PERFORMANCE.md) for candidate scopes.

The v0.1 release requirement is six excellent working games plus the ROM Desk workbench. Every package includes [ROM Desk](DESK.md); its stepping-agreement tests run with the integration tests. `build --deploy` requires every registered title to be ready and verified for the current sources, and fails with `RELEASE_GAMES` otherwise. A Learn-only or study artifact is not the release. Only the main-merge workflow deploys.
