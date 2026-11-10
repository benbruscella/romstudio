# Elite

This C64 study boots the pinned V1.1+ release, declines ten trainers, and follows the original new-commander flow into docked status, launch and bounded flight controls. Original/static replay compares state, pixels, inputs and approximate SID samples. Saved commanders, trading progression and combat outcomes remain unverified.

[Recipe](recipe.json) · [Project status](../../../../docs/PROJECT-STATUS.md) · [Contributing](../../../../CONTRIBUTING.md)

## Chapters

- [Boot](docs/BOOT.md)

## Reading the code

The recipe pins original bytes and launch conditions. Recovery code runs original instructions during analysis. Generated `game-code/program.ts` retains source addresses. Named interpretations under `code/`, where present, explain observed routines; browser labels and controls belong in `web/`. These layers have different purposes and should remain visibly separate.
