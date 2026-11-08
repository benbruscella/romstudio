# Nebulus / Tower Toppler

The second C64 study shares hardware with Lemmings while keeping its loader, tower state and controls separate. Play should run the original opening music and wait for Space/Fire. The reported longer tunnel/next-Up route is a required regression; tower completion remains unverified.

[Recipe](recipe.json) · [Project status](../../../../docs/PROJECT-STATUS.md) · [Contributing](../../../../CONTRIBUTING.md)

## Chapters

- [Boot](docs/BOOT.md)
- [Gameplay](docs/GAMEPLAY.md)

## Reading the code

The recipe pins original bytes and launch conditions. Recovery code runs original instructions during analysis. Generated `game-code/program.ts` retains source addresses. Named interpretations under `code/`, where present, explain observed routines; browser labels and controls belong in `web/`. These layers have different purposes and should remain visibly separate.
