# Food self-sufficiency

## Why

Pax keeps dying at low health with no food. `keep_fed` only looked within its radius (64 for
Pax), found no animals near the busy spawn and backed off, so nothing ever got it food. Bots
need to find food further away, grow their own and keep a herd going.

## What changes

- New `food` skill (`src/skills/food.ts`, in `extendedSkills()`): `find_food` scouts an
  expanding spiral around home for huntable animals or village farms and remembers what it
  finds; `start_farm` gets seeds from grass, makes a hoe, picks flat grass by water away from
  protected areas and builds, tills and plants a plot and registers it as `farm:<n>`; `breed`
  feeds a pair of adults (leading them to the farm first).
- Pure planning in `src/skills/foodPlan.ts`: scout waypoints and give-up rules, food spot
  memory (merge, rank, forget), farm site scoring, plot layout, seeds, bread, breeding food and
  breeding plan.
- `keep_fed`: new steps own farm, known food spot, scout and start farm; new options `scout`,
  `scoutRadius`, `scoutAtNight`, `keepAtLeast`, `places`, `startFarm`, `anyCrops`. Crops are
  only taken from its own or village farms by default. Far trips only by day.
- New behaviour `farm_setup` (set up, tend, bake, breed). `farm_loop` gets a `place` option.
- `hunt` gets `keepAtLeast` and walks up to animals more than 16 blocks away (fight gave up beyond 24); `harvest` and `plant` take an optional field centre `x y z`.
- Fix: `isMature` read block ages as numbers, but prismarine-block returns them as strings (`'7'`), so harvest never saw a ripe crop.
- Journal types `food_spot` and `farm_started` (core: two names added to `JOURNAL_TYPES` plus
  formatting; backwards compatible).
- Pax arms `keep_fed` with scouting and `farm_setup`; its AGENTS.md puts food first.
- `scripts/food-test.ts` for a live check.

## Non-goals

- No bucket crafting or iron gathering; water comes from nature or a bucket it already has.
- No animal pens or automatic fence gates; the fence ring has a gap.
- No fishing.
