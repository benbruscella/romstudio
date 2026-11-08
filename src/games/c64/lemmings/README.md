# Lemmings

The first C64 study follows disk startup, the first two level data sets, terrain and a complete digger action. The checked first-level route rescues six of ten. Wider progression and other skills remain partial.

[Recipe](recipe.json) · [Project status](../../../../docs/PROJECT-STATUS.md) · [Contributing](../../../../CONTRIBUTING.md)

## Chapters

- [Boot](docs/BOOT.md)
- [Browser](docs/BROWSER.md)
- [Digger](docs/DIGGER.md)
- [Levels](docs/LEVELS.md)

## Reading the code

The recipe pins original bytes and launch conditions. Recovery code runs original instructions during analysis. Generated `game-code/program.ts` retains source addresses. Named interpretations under `code/`, where present, explain observed routines; browser labels and controls belong in `web/`. These layers have different purposes and should remain visibly separate.
