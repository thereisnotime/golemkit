# Food sources that keep working in the cold

## Why
Pax lives on a frozen lake shore with no bucket. Its farm farm:1 was marked flooded ("46 of 80
cells are water or ice"), start_farm found no new site ("2 shore ice blocks, none usable (2
somebody's build)"), and the base's reserved farm plot stayed empty. It lived off the pantry.
Three things were wrong: an older shore farm was judged on the whole square, so the lake beside it
read as a flood; a bad farm was always dropped, never repaired; and the bot's own torches, walls
and farms counted as somebody else's build. And there was one food source, a farm by water.

## What changes
- An ordered, configurable list of food sources (`food.sources`: repair, farm, plot, animals, fish,
  forage), picked by what the area allows; farm_setup runs the chosen one and says which and why
  the ones before it were skipped (`food_sources` action, farm_setup results, the food observation).
- `repair_farm`: a bad farm is repaired where it is (thaw frozen water, fill flooded cells with dirt,
  put the water back with a bucket) or moved, as `farming.badFarm` says (auto, repair, relocate, off),
  with `repairMaxBlocks` and `repairTries`.
- Older farms without a land list are judged on the dry field left.
- `plot_farm`: the base's farm plot becomes a farm without a bucket: water in reach, carried ice
  (Silk Touch only), or a dry plot lit by torches (`farming.plot`, `plotWater`, `plotSwap`).
- `fish`: a rod from 2 string and 3 sticks, open water or a hole broken in lake ice.
- Its own work never counts as somebody's build near a farm site (`farming.ownBuilds`,
  `ownBaseRadius`); the reason names the block.
