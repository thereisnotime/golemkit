## Why
Pax had stone tools and no armour for days. Its gear search started every 5 minutes and was cut short after 5 to 78 seconds, dozens of times in a row, and nothing said what took over: the search only ran while no other behaviour scored above the idle band, so drops to pick up, farm and seed chores and the eat reflex ended it, and the base project took the slot until the next try. Its one mine trip went down at night, turned back after 5 stair steps for two zombies walking over the entrance, and placed none of the 16 torches it had made (the first was due at step 8), so the mine never counted as lit and night trips never used it. keep_tools_upgraded kept trying to re-make a worn stone sword with no stone in the inventory ("need 2 cobbled_deepslate", the first recipe variant listed), which backed the behaviour off while its upgrades waited.

## What Changes
- A running need search holds its slot at `needs.search.holdScore` (default 30): only work beating it by the switch margin takes over. `0` gives the old rule.
- A search cut short because the body was taken (a reflex, a player) is no real try and may start again at once, `needs.search.resumes` (default 3) times per cooldown.
- The controller names what took over a running behaviour; the search record keeps `by`, `why`, `resume`; the layer logs it at info; `just status` shows the last search and the last takeover.
- Underground retreat counts hostiles under open sky only within `mining.hostileClose` (default 4) unless `mining.surfaceHostiles` is on.
- The first torch in a mine with none goes after `mining.firstTorchAt` (default 4) steps; `dig_mine` lights the dark stairs of a known mine on the walk down (`mine.relight`, default on).
- Crafting picks the recipe variant it can make or is closest to (`rankRecipes`), and keep_tools_upgraded only re-makes a worn tool it has the materials for (`remakeable`).

## Impact
- `src/brains/npc/needs.ts`, `controller.ts`, `types.ts`, `src/core/needs.ts`, `status.ts`, `toggles.ts`
- `src/skills/minePlan.ts`, `mining.ts`, `stairMinePlan.ts`, `stairMine.ts`, `crafting.ts`, `toolkit.ts`, `src/adapters/minecraft-java/behaviors/tools.ts`
- docs: needs-and-idle, progression, status, live-config, config reference
