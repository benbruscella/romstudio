# Tetris

This NES study runs the supplied PRG/CHR chips on a declared MMC1 board. Recorded routes cover startup, menus, piece movement, rotation, soft drop and pause/resume. A named controller-filter interpretation is checked against the original instructions. The original sound driver feeds the shared PAL APU; builds compare original/static machine state, pictures and per-frame PCM audio. Full progression and independent hardware parity remain unverified.

[Recipe](recipe.json) · [Project status](../../../../docs/PROJECT-STATUS.md) · [Contributing](../../../../CONTRIBUTING.md)

## Chapters

- [Startup](docs/STARTUP.md)
- [Original sound driver](docs/AUDIO.md)

## Reading the code

The recipe pins original bytes and launch conditions. Recovery code runs original instructions during analysis. Generated `game-code/program.ts` retains source addresses. Named interpretations under `code/`, where present, explain observed routines; browser labels and controls belong in `web/`. These layers have different purposes and should remain visibly separate.
