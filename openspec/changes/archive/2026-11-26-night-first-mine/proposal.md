## Why
Pax never dug a mine. Night trips needed a lit mine, and by day the mine came only after the surface search for iron, which ran late (after the base work) and turned back at sunset. A turned-back search went home instead of on to the mine near home, so no mine was ever dug and night never qualified.

## What Changes
- New `mine.startAtNight` (default on): with no mine yet, a night trip may start the first one when the bot has 8 torches or can make them. It lights the stairs as it digs.
- A surface search that turns back for the light goes on to the mine when night trips may go, instead of home.

## Impact
- `src/skills/stairMinePlan.ts` (`nightMineOk`, `turnedBackForLight`, setting), `src/adapters/minecraft-java/needs/index.ts`, `src/core/toggles.ts`, docs.
