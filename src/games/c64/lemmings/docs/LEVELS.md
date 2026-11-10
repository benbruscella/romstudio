# Reading Lemmings through its first two levels

ROM Studio now follows the original one-player menu path into the first two levels and stops immediately after each level releases its first lemming. This chapter explains the recovered level header, terrain reads and entity arrays. The names in the TypeScript are ours; the addresses and behavior come from this release's instructions.

```sh
npm run cli -- level
npm run cli -- level --number 2
```

Each command prints a local output directory. Open `level.json` for the named data, `terrain.png` for a diagnostic terrain atlas, and `level.asm` for the original setup, release and terrain-probe instructions. `report.json` records the inputs, disk mounts, execution checkpoint, launch fixtures and verification results. The captures also include RAM, the known-memory mask, raw terrain pairs, an ordinary collision mask and observed instruction variants.

Start reading at [decodeLevelHeader and sampleTerrain](../code/level-data.ts). Then follow [the level scenario](../recovery/level.ts) to see how the original code produces their inputs. [The boot chapter](BOOT.md) covers the earlier unpackers and trainer prompts.

## From the menu to a level

The menu calls GETIN and tests its result at `$91E3`. Returning the character `1` takes the one-player branch. Routine `$9349` derives the selected level's code, and `$924D` restores the normal display before entering the next loader stage.

The first level uses the initial selector value. The second-level scenario explicitly sets the menu's level-index field at `$9BC2` to 1 before returning `1`. This is a declared selection fixture, rather than a replay of the password-entry dialog. The original selection and loading routines still execute. ROM Studio does not substitute `FB` for a request for `FA`.

| Scenario | Observed file requests after the menu | Recovered name                 | First released position |
| -------- | ------------------------------------- | ------------------------------ | ----------------------- |
| Level 1  | `FA`, `SA`                            | Just dig!                      | `(126, 52)`             |
| Level 2  | `FB`, `SB`                            | Only floaters can survive this | `(94, 21)`              |

Both runs first read `ID`, `IE`, `PA`, `CA`, `CB` during startup. `FA` and `FB` reside on the second supplied disk. A disk provider mounts the unique pinned disk containing a requested file; an ambiguous request fails instead of choosing arbitrarily. The report retains the actual media hash and directory entry for each stream. `SA` and `SB` are observed subsequent loads; this trace alone does not assign meanings to the entire `S` file family.

The original `$CE7C` decoder expands the level file into high RAM, including the header at `$E000`. Routine `$E094` performs another expansion and rearrangement. It is a decoder, not a level-parameter setter. Execution then reaches the engine's setup at `$1000` and its main update code.

## The header is more than a name and some numbers

Two files help distinguish the format from accidental padding. In the first file, “Just dig!” occupies a small part of a padded field. The longer second name establishes that the name starts at `$E019` and spans 30 bytes.

| Address       | Recovered use                                     | Evidence in the original code                                                                |
| ------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `$E019–$E036` | Thirty-byte name in the release's screen alphabet | Both decoded headers and their status display                                                |
| `$E037–$E038` | Display text for the lemming count                | Decimal characters in the header                                                             |
| `$E039`       | Binary lemming count                              | `$1E0B–$1E11` stops releases when the count is reached                                       |
| `$E03A–$E03B` | Rescue percentage shown to the player             | Decimal display characters; the browser compares this requirement with original end counters |
| `$E03C`       | Release-interval table index                      | `$10EE` initializes `$0578`; `$1E02` uses it to select the release increment                 |
| `$E03D–$E03F` | Release rate shown to the player                  | Decimal display characters; it is not the raw interval index                                 |
| `$E041–$E043` | Minutes, tens of seconds, units of seconds        | `$11A7` copies them to `$CB39–$CB3B`; `$0EE9` decrements the timer                           |
| `$E044–$E04B` | Tens digits for eight skill stocks                | `$1196` copies them to `$05C8–$05CF`                                                         |
| `$E04C–$E053` | Skill-stock units digits                          | `$119E` copies them to `$05D2–$05D9`; the preceding array holds tens                         |
| `$E06C–$E074` | Up to three entrance records                      | `$1E21–$1E5B` selects and uses the records                                                   |
| `$E075–$E07A` | Up to two exit records                            | `$1351` patches the exit tests at `$1F80`                                                    |
| `$E07B`       | Number of entries in the object tables            | `$2A54` patches the loop limit at `$2B1C`                                                    |
| `$E080–$E093` | Ten little-endian pointers used by setup          | `$1000` copies them into instruction operands and working tables                             |

An entrance or exit record stores X as a **big-endian** word, then Y as one byte. A Y value of `$FF` disables the record. This differs from the little-endian instruction operands and pointer table. Reusing one word reader for every field would misread the positions.

The text also needs its own decoder. Codes 1–26 represent lowercase letters, while `$41–$5A` retain uppercase letters. `levelText` implements this observed mixed alphabet and rejects unsupported codes.

Both levels specify ten lemmings, show a rescue requirement of 50%, show release rate 10, and start with five minutes. The actual interval index is 11. Level 1 has ten uses in slot 7; level 2 has ten uses in slot 1. Stock uses separate tens and units digits, as established by the consumption routine in [the digger chapter](DIGGER.md). Slot 7 is now verified as the digger; the report retains numbered slots for the remaining handlers.

## Spawning uses arrays instead of entity objects

The release routine at `$1DD9` adds a table-selected increment to an eight-bit accumulator. Carry out triggers a release attempt. Once the entrance-opening state allows it, the routine compares the number already released at `$05B7` with `$E039`, selects an enabled entrance and initializes an array slot.

The relevant layout is:

| Base address | Value for lemming index `i`                              |
| ------------ | -------------------------------------------------------- |
| `$0424 + i`  | Mode and direction byte                                  |
| `$0456 + i`  | Animation/state bits, including bit 0 of the X high byte |
| `$0488 + i`  | X low byte                                               |
| `$04BA + i`  | Y                                                        |
| `$051E + i`  | Additional per-lemming state                             |

For a new lemming, `$1E44` adds 2 to the entrance's X and `$1E55` adds 5 to its Y. Level 1's entrance `(124, 47)` therefore produces `(126, 52)`. Level 2's entrance `(92, 16)` produces `(94, 21)`. These relations are checked against the actual array writes, not just against decoded header values.

The scenario stops at `$1E69`, the release routine's return, after the first entity has been initialized. It does not yet prove walking, skill assignment, rescue or completion. Array storage also explains why the X high byte must be masked: the rest of `$0456 + i` contains other state.

## Terrain and collision share the original pixel data

The terrain is mutable two-bit pixel data addressed through lookup tables. It is not a rectangular array of tile IDs. Routine `$287E` patches the terrain reader's operands for the current lemming, then `$28EC–$290F` combines horizontal and vertical table entries to locate a byte and mask one of its four two-bit pairs.

`sampleTerrain` raises that operation into a named function. It reads the original tables at `$4800`, `$4900`, `$4A00`, `$4C00` and `$4E00`, includes the low-byte carry, and extracts the selected pair. A horizontal adjustment table uses both positive offsets and `$FF` as a negative offset. Treating every table byte as an unsigned displacement gives incorrect samples.

The current reviewed atlas covers logical X 0–319 and Y 16–168. The original movement code rejects a rightward position at 320 and tests the bottom limit at 169. The clamped upper border remains outside this reader's declared domain. One logical sample occupies two horizontal VIC pixels, so the atlas exports 640 by 153 physical preview pixels with a world Y origin of 16.

The ordinary probe tests whether the selected pair is nonzero. The helper at `$2910–$2924` additionally turns pair 3 into an empty result for its callers. These two predicates remain distinct. A single “solid” flag would discard behavior that particular skills or movement states may depend on.

`terrain-pairs.bin` stores one pair value per logical sample. `ordinary-collision.bin` stores the ordinary nonzero predicate. `terrain.png` shows the pairs using diagnostic colours; it omits objects, entities and the toolbar. `level.png` uses the generic VIC snapshot renderer, whose raster splits and sprite multiplexing are incomplete. Neither preview is independent evidence of hardware parity.

The tests compare named terrain reads with execution of the original `$28EC` instructions at 72 coordinates per level, including different pair positions, layout adjustments and the X=255/256 boundary. The alternate classifier is also checked against its original instruction sequence. This verifies the raised reader over those samples; it does not verify every gameplay collision decision.

## Initialization assumptions remain visible

The first cursor update restores an old cursor before setting its new pointer. Its zero-page workspace needs a defined launch state. The documented [KERNAL `$FD50` startup loop](https://skoolkid.github.io/sk6502/c64rom/asm/FD50.html) clears `$0002–$0101`, `$0200–$02FF` and `$0300–$03FF`. The level scenario seeds otherwise unknown bytes in those ranges. Later BASIC activity is not fully reproduced, so this remains a declared startup fixture.

The loader also draws a previous-level status before loading the first real level. The scenario supplies an explicit 256-byte previous-header fixture at `$E000`. This buffer is not accepted as recovered level data: every byte must have an observed writer before decoding the actual header. A sensitivity test reruns level 1 with the initial buffer filled with `$FF` rather than zero and compares the recovered header, terrain, collision mask and first entity. The selected file must determine those results.

The CIA port fix supporting fire-button input follows the [MOS 6526 datasheet](https://www.retrodocs.fr/wp-content/uploads/pdf/MOS-6526.pdf): port reads observe pin levels, allowing an external switch to pull a line low even with the direction set to output. The menu's display restoration also reads documented KERNAL initialization data and enters the [video timing tail at `$FF5E`](https://skoolkid.github.io/sk6502/c64rom/asm/FF5B.html). ROM Studio supplies these small contracts without importing a firmware image or an external emulator.

[The digger chapter](DIGGER.md) follows selection, assignment and terrain edits. [The browser chapter](BROWSER.md) continues through a checked completion route and static export. Wider coverage, full audiovisual fidelity and the rest of the title remain outstanding.

This chapter's code lives in [`recovery/level.ts`](../recovery/level.ts) and [`code/level-data.ts`](../code/level-data.ts) under [`src/games/c64/lemmings/`](..). The shared renderer now honours `$D016` horizontal fine scrolling, following Nebulus's doorway regression. That display offset changes neither logical terrain coordinates nor the atlas format. The running browser uses the separate raster sequencer and bus timing described in [its display chapter](BROWSER.md).

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
