## Why
Pax starved next to its base: food 5, pantry empty, "nothing to eat within 250 blocks of home". It lives in a snowy biome (no grass, frozen shores, few animals), its chests held string and single wheat, there was open water 25 blocks away, and it died with 18 rotten flesh in its bag. The ladder had no fishing step, the rod check only looked at the inventory, wheat in chests did not count, rotten flesh was never eaten, and at food 6 it set off on a trip to a village 3500 blocks away. Scouts that ran out of air or never started were remembered as empty rings, which is where "nothing within 250 blocks" came from.

## What Changes
- keep_fed ladder: `eat_rotten` (food at or below `eatRottenAt`, default 6, with nothing better carried), `bread` from wheat in its chests, and `fish` after hunting (open water or lake ice within `fishRange`, default 48, with a rod it has or can get).
- Starving (food at or below `critical`): its farm, remembered spots and known places further than `starvingRange` (default 96) are skipped.
- The `fish` action takes a rod, or the string, sticks or planks for one, from its chests (pure `rodPlan`); the food-source registry counts that too.
- `eat` takes an optional `item`, so the ladder can eat rotten flesh on purpose.
- A scout cut short by air or that never got going is not recorded as an empty ring.
