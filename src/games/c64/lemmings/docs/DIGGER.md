# Reading Lemmings through its digger

The first skill chapter follows a complete digger action in “Just dig!”. ROM Studio selects the skill through the C64 keyboard matrix, moves the cursor using joystick pins, presses fire over a walking lemming, and lets the original instructions dig through the terrain. The readable implementation runs alongside that execution in a separate memory copy.

```sh
npm run cli -- dig
```

The command prints an output directory containing `terrain-before.png`, `terrain-after.png`, `digger.asm`, `stroke-checks.json`, `input-replay.json`, RAM snapshots and `report.json`. The terrain atlas shows the actual two-bit pairs using diagnostic colours; it is not a raster screenshot. Commercial data stay in ignored local output directories.

Replay the recorded controls with:

```sh
npm run cli -- dig --replay <output-directory>/input-replay.json
```

Start with [the named digger routines](../code/digger.ts), then [the execution and comparison scenario](../recovery/dig.ts). These are explanatory names linked to original addresses, not recovered author symbols. The chapter builds on [level data and terrain probes](LEVELS.md).

## Selection, targeting and assignment are separate operations

The game's keyboard scan at `$0A77` tests a table of column and row masks. The eighth skill uses PA3/PB3, the `8` key. Closing that switch makes the original scan write slot 7 to `$05C0`. ROM Studio supplies the switch closure through CIA1 rather than writing the selection field.

The [C64 Programmer's Reference Guide](https://www.monkeyspeak.com/c64_hardware_details/Commodore_64_Programmers_Reference_Guide_1983_Commodore.pdf) describes the keyboard as an eight-column, eight-row switch matrix scanned through CIA1's two ports. ROM Studio models digital low-level propagation through closed switches in either direction. It retains an explicit gap for the default KERNAL IRQ's scan with held keys; this game uses its own scan during gameplay.

The joystick then moves the original cursor. The controller reads the first lemming's position, cursor position and scroll origin to decide which direction pins to pull low. It never changes cursor or entity coordinates. Once the game's own targeting logic has identified lemming 0 and its mode is walking, the controller sends one fire press and releases it.

At `$1501–$153B`, the click dispatcher checks the pending click, the targeted lemming at `$05C1`, the selected slot at `$05C0` and the remaining stock. It looks up the slot's handler in the tables at `$15BA` and `$15C2`. Slot 7 reaches `$164C`, which identifies this slot as the digger.

The assignment checks the current mode before changing it. Falling mode 2, existing digging mode 6, modes 0/1 and modes `$10/$11` reject this action. An accepted assignment preserves the upper two mode bits and selects mode 6. It keeps the low three animation/state bits and the high bit of the extra-state byte, resetting the other animation state.

`assignDigger` expresses these decisions as a state transition. Its caller must already have targeted an entity; the function does not perform cursor selection itself. Tests execute the original click dispatcher for accepted and rejected modes and for empty, one-use and ten-use stocks.

## Stock is stored as two digits

The earlier header interpretation exposed the first stock array as a count. Tracing consumption shows that it is the **tens** array. `$1196` copies `$E044–$E04B` to `$05C8–$05CF`, and `$E04C–$E053` to the units array at `$05D2–$05D9`.

The first level therefore supplies ten diggers: slot 7 contains tens 1 and units 0. The release's trainer-aware decrement routine at `$DFA0` checks the corresponding bit in `$CFFC`. With trainers disabled, it borrows one ten, supplies ten units, then subtracts one unit. The first assignment changes `(1, 0)` to `(0, 9)`.

`readSkillStock` converts these digits into a count. The display routine can replace an unavailable `(0, 0)` stock with the paired blank codes `(10, 10)`; both represent zero available uses. `decodeLevelHeader` now exposes full counts and retains the separate source digits.

## Animation frames define the digging pattern

The mode dispatch tables at `$1E6A/$1E7F` send mode 6 to `$244A`. The handler divides the animation byte by eight to obtain a frame index, then looks up the points to clear for that frame and, when needed, the next frame.

| Table           | Role                                      |
| --------------- | ----------------------------------------- |
| `$3F98 + frame` | Number of points for this animation phase |
| `$3FA8 + frame` | First point index                         |
| `$3FB8 + point` | Horizontal offset from the lemming        |
| `$4BF2 + point` | Vertical offset from the lemming          |

The point list ends at index 13. Some frames have no points, so a digger can animate without changing terrain on every update. The extra-state byte accumulates how many occupied samples the current cut encountered.

`updateDiggerStroke` follows that table-driven process. When it reaches the final point, it examines the accumulated occupancy. If it encountered terrain, the handler returns movement index 10 and clears the accumulator. The common movement tail supplies the downward movement. If it encountered no terrain, it switches to falling mode 2 and returns movement index 7. Other phases return movement index 8.

The named function covers the handler before the common movement and animation tail. It returns that movement index rather than silently reimplementing the rest of the engine. The original tail still moves the authoritative entity and advances its animation.

## Clearing the world and its displayed copy

The clear routine at `$2930` uses the same lookup tables as the terrain probes. It selects a two-bit pair and clears only those bits. It also counts whether the pair was occupied before the store.

There are two possible stores. The world bitmap is authoritative. For a visible column, the routine also clears the corresponding pair in the separate display bitmap. Each store preserves the other pairs in its own byte. If the world pair is already empty, `$2995–$299A` skips both stores, preserving any composited display graphics there. Copying the new world byte directly into the display, or clearing an empty pair unconditionally, would discard this behavior.

`eraseTerrainPair` raises those stores into readable code and returns their addresses and before/after values. Tests compare world and display memory with original instruction execution for visible and offscreen columns, different packing adjustments and the X=255/256 boundary.

Special-terrain handling branches through additional metadata when `$E07C` is nonzero. The first level takes the ordinary path. The named digger routine rejects the unraised special path explicitly; it does not treat every level's digging rules as identical.

## What this replay proves

The bounded run observes 200 entries to the level-update routine. Its first assignment changes stock from ten to nine. The original handler runs 134 times and removes 139 logical terrain samples before the entity returns to walking.

Before each handler call, ROM Studio clones the recovered memory and runs `updateDiggerStroke` there. At the original handler's return it compares the mode, animation state, extra state, returned movement index, world bitmap and display bitmap. The original instructions remain authoritative throughout; the comparison does not replace them with the named function.

The input log records changes to joystick pins and the `8` key switch at numbered cursor-control calls. A second execution starts from the pinned disk PRG, applies those recorded inputs and compares CPU state, terrain, RAM and input hashes. This is deterministic replay evidence inside ROM Studio. It is not an independent C64 hardware trace.

CPU flags and instruction timing are outside the raised routine's contract. The launch fixtures and approximate PAL services remain declared. This checkpoint verifies one ordinary-terrain digger action. [The browser chapter](BROWSER.md) continues through a checked completion route and static export; other skills, special terrain, full audiovisual fidelity and the rest of the title remain outstanding.

Game code is grouped in [`src/games/c64/lemmings/`](..): `code/digger.ts` contains the named routines, `recovery/dig.ts` runs this comparison, `recovery/controls.ts` supplies example inputs, and `player.ts` adapts the shared player. The browser still executes original instruction functions for authoritative gameplay and SID writes. [Audio](../../../../../docs/systems/c64/AUDIO.md), bus slots and fine scrolling belong to the common runtime and do not expand the raised digger routines' timing contract.

See the shared [documentation index](../../../../../docs/README.md) and [current verification status](../../../../../docs/PROJECT-STATUS.md) for commands, cross-system work and outstanding acceptance checks.
