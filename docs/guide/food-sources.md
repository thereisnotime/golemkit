---
scope: minecraft
---

# Food sources

`keep_fed` handles hunger in the moment: eat, cook, the pantry, hunting, searching. What keeps the
food coming over days is `farm_setup`, and in a cold biome a farm by a lake doesn't last. Pax lives
on a frozen lake shore with no bucket. Its farm was marked flooded, `start_farm` found nowhere new,
and it got by on the pantry. So `farm_setup` now picks from a short ordered list of food sources,
says which one it uses and why it skipped the ones before it, and repairs a bad farm before giving
it up.

## The list

`settings.food.sources` is the order of preference. A source left out is never used.

| source | kind | used when |
|---|---|---|
| `repair` | lasting | one of its farms is marked bad by [site health](./needs-and-idle#site-health) and `farming.badFarm` allows a repair ([below](#bad-farms-repair-or-move)) |
| `farm` | lasting | it may dig and has 8 seeds (`food.minSeeds`, carried plus in its chests) or grass near: `start_farm` looks for flat ground by water (or ice, or a bucket hole) |
| `plot` | lasting | its base keeps a farm plot free inside the walls (the `farm_plot` [base project](./base-projects)) and `farming.plot` is on ([below](#the-base-s-farm-plot)) |
| `animals` | stock | a breeding pair with food for it, or animals beyond two breeders per kind, within 32 blocks of home |
| `fish` | stock | a fishing rod, or 2 string and 3 sticks (or planks, or a log) to make one, and open water or lake ice within 48 blocks of home |
| `forage` | stock | ripe sweet berries, or kelp it can smelt, within 32 blocks |

Lasting sources are set up once and then kept up: a farm that stands wins in its place in the
list, and `farm_setup` tends, harvests and replants it as before. Stock sources run one session
(fish for 5 minutes, breed or hunt, forage) whenever the food it carries plus what its chests near
home hold is below `food.stock` (12 items).

The default order is `repair, farm, plot, animals, fish, forage`. A field farm is the better
source when the land allows it (a 9x9 by water against a 3x3 plot), so it comes before the plot;
with only the plot standing, a field farm is still tried now and then. A source that fails is
skipped for `food.retryMinutes` (60), so the next one in the list gets its turn.

The choice is a pure function (`chooseFoodSource` in `src/skills/foodSourcePlan.ts`); adding a
source means adding one entry to `FOOD_SOURCES` with its `assess` (and `have` for a lasting one),
and one case in `runFoodSource` (`src/skills/foodSources.ts`).

### Where to see it

`farm_setup`'s results (status: last success or failure) end with the line, and the `food_sources`
action says it on demand:

```
food source: plot (a plot inside the base, 3 seeds); skipped repair: gave up on farm:1 after 2 tries;
farm: failed 12m ago: no flat grass next to water within 96 blocks of home ...
```

The LLM sees the same line in the `food` skill's observation (`foodSource`).

## Bad farms: repair or move

Site health marks a farm bad when its field floods or its water freezes. Before, the farm was
dropped and a new one started near home, away from the old spot. Now `repair_farm` looks at it
first (`planFarmRepair` in `src/skills/farmRepairPlan.ts`):

| what it finds | what it does |
|---|---|
| reads fine (a false alarm, or a player fixed it) | puts it back on its list |
| the middle water froze | breaks the ice (with a tool without Silk Touch: it turns back into a source) and keeps it open with a block over it or a torch, as on [cold ground](./needs-and-idle#farming-on-cold-ground) |
| the middle water is gone | puts it back with a bucket, if it has one |
| field cells are water or ice now (the lake crept in) | fills each with dirt: a block placed into water replaces it. Ice is broken first. Then `tend_farm` tills and plants them again |
| water running over most of the field from above | can't be fixed from the plot: moves |

`farming.badFarm` decides:

- `auto` (default): repair when it is a small job (at most `farming.repairMaxBlocks`, 16, cells to
  fill; the ice can be broken and kept open; enough dirt carried, in its chests or to dig), else a
  new farm elsewhere.
- `repair`: never moves. When the repair is too big it leaves the farm and tells the owners.
- `relocate`: never repairs (the old behaviour).
- `off`: neither; the owners are told.

After `farming.repairTries` (2) repairs that didn't take, it gives up on that farm (moves in auto).

### The false alarm on Pax's farm

Pax's farm:1 went bad on "46 of 80 cells are water or ice". The farm was older than the land list
(the cells that were land when it was made), so the check counted the lake beside the shore farm
as flooding. Farms without that list are now judged on the dry field left: half the square wet
only counts as flooded when fewer than 8 dry cells (farmland or tillable) remain. When such a farm
comes back (`repair_farm` or the next site re-check), its land list is recorded.

## The base's farm plot

The `farm_plot` base project keeps a 3x3 (or 5x5) plot free inside the walls. `plot_farm` turns it
into a farm without a bucket (`planPlotFarm` in `src/skills/plotFarmPlan.ts`). What makes that
possible, in Minecraft 1.21.1:

| rule | consequence |
|---|---|
| Farmland is wet when water (source or flowing) is within 4 blocks sideways, at its height or one above | water already near the plot is used as it is |
| Dry farmland with a crop on it stays farmland; bare dry farmland turns back into dirt | a plot with no water works, if every cell it tills is planted at once. It only tills as many cells as it has seeds |
| Growth chance per random tick is 1 / (floor(25 / f) + 1); f is 10 on an all-wet 3x3 and 4 on an all-dry one | 1 in 3 wet, 1 in 7 dry: a dry plot grows a bit under half as fast (wheat about 55 minutes instead of 24) |
| Crops grow at light 9 or more at the crop, sky or block light, any time of day | under the sky that is always true; under a roof it takes torches (14 at the torch, one less per block) |
| Ice broken without Silk Touch over a solid block becomes a water source, but it drops nothing | ice can't be carried to the plot without a Silk Touch tool. With one, it puts the ice in the middle and breaks it with a bare hand or plain tool |
| Water freezes in a cold biome only as the top block under the sky with block light below 10 | inside a roofed base it never freezes; inside open walls a torch one step outside the plot gives it 10 or 11 |
| Snow never settles on farmland or crops | snow on the plot is cleared once, before tilling |

So `plot_farm`, with `farming.plotWater`:

- `auto` (default): water in reach of the whole plot if there is any, else carried ice, else a dry
  plot with a torch in the middle.
- `water`: only with water.
- `dry`: never bothers with water.

Torches go where they light the most dark cells until every crop cell has light 9 (it reads the
light the server sends; without light data it puts the middle torch up and says it couldn't
check). Stone, sand or gravel cells are dug out and filled with dirt when `farming.plotSwap` is on
and it has the dirt. The farm is saved as `kind: plot`, `water: none | natural | ice`, and tended
like any farm, but never grown past the plot.

## Somebody's build

`start_farm` rules a site out when placed blocks are on it or in a 3-block ring around it, so it
doesn't farm in someone's base. On Pax's frozen shore, the only two shore ice blocks were ruled out
as "somebody's build". The check matched any planks, cobblestone, fence, torch or farmland, and
the only such blocks near that shore are its own: the torches `light_home` put along the lake (its
torch list has some at the water's height), the fences, torches and farmland of its own bad farm
and its fortress walls. The old reason didn't say which block it was, so this is read from Pax's
store, not seen. Now its own work never
counts (`farming.ownBuilds`, default on):

- blocks it remembers placing (`build.own`) and its torches (`lighting.torches`),
- finished builds (`build.placements`, with a block of margin),
- the squares of its farms, healthy or bad, with the fence ring,
- `farming.ownBaseRadius` (12) blocks around its base's anchor (base projects), since walls built
  before `build.own` existed are not in it.

Natural ice was never a build (it is handled as the lake when the water is kept open). The reason
now names the block that ruled the site out ("somebody's build (oak_fence at 566 63 -16)") so a
wrong call is easy to see.

## Settings

| key | default | what |
|---|---|---|
| `food.sources` | `repair, farm, plot, animals, fish, forage` | the sources and their order |
| `food.stock` | 12 | stock sources run below this many food items (carried plus chests) |
| `food.retryMinutes` | 60 | a failed source is skipped this long |
| `food.minSeeds` | 8 | seeds to start a field farm without grass near |
| `farming.badFarm` | `auto` | `auto`, `repair`, `relocate`, `off` |
| `farming.repairMaxBlocks` | 16 | most cells it fills in one repair |
| `farming.repairTries` | 2 | repairs per bad farm before it gives up on it |
| `farming.ownBuilds` | on | its own work is not somebody's build |
| `farming.ownBaseRadius` | 12 | around its base's anchor counts as its own |
| `farming.plot` | on | use the base's farm plot |
| `farming.plotWater` | `auto` | `auto`, `water`, `dry` |
| `farming.plotSwap` | on | swap stone cells of the plot for dirt |

`farm_setup`'s option `sources: false` goes back to the old rule (only `start_farm`).
All of them are [live toggles](./live-config).
