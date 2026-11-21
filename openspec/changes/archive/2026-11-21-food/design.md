# Design

## Decision order (pure)

`nextFoodStep(world, options, tried)` picks the next step; failed steps go into `tried`.

1. eat ready food
2. cook raw food (smelt, furnace crafted if needed)
3. bake bread (3 wheat)
4. eat safe raw meat (eatRaw), withdraw from a known chest
5. harvest crops in range (own farm, village farm; any crops only with `anyCrops`)
6. own farm further out: ripe if visible, or due after 20 minutes out of sight
7. known food spot: when within `radius`, or when nothing is huntable here
8. hunt: adults above `keepAtLeast` per kind; the whole herd only when starving (health or food <= 6)
9. scout (`find_food`) out to `scoutRadius`
10. start a farm (`start_farm`) when it has none and has seeds or grass nearby

Far trips (6, 7 beyond `radius`, 9, 10) need day or `scoutAtNight`. At night keep_fed fails
and backs off and `stay_safe` (night score 48 < keep_fed 55+) takes the bot home. Reflexes
still outrank everything.

## Scouting

Rings every 64 blocks (animals are tracked ~64 blocks out), waypoints every ~96 blocks on a
ring, rings walked inside out, starting at the angle pointing away from the world spawn. Pure
helpers: `scoutWaypoints`, `nextWaypoint` (skips visited waypoints and anything further out in
a sector where a leg got stuck), `scoutStopReason` (night, health <= 6, 3+ hostiles, 4 stuck
legs in a row, leg/distance/time budget). Each leg is a `travel()` whose `onProgress` looks
around and aborts the leg once food is in view.

## Memory

`agent.storage.foodSpots`: `{ kind, x, y, z, dim, seen, count, animals, emptyVisits, emptyAt }`.
`mergeSpot` replaces a spot of the same kind within 32 blocks, keeps 8 per kind;
`rankSpots` filters stale ones (animals 6 h, village farms 3 days, water 30 days) and ones
found empty in the last 30 minutes, then sorts by food minus distance/32; `markSpotEmpty`
drops a spot after two empty visits. The best of each kind is also a named place
(`food:animals`...), so the LLM and `goto_place` see it. Farms live in `agent.storage.farms`
and as places `farm:<n>`.

## Farm site

For each shore water source (level 0, air above, land next to it) within `radius` (then out to
96 blocks), a 9x9 square at the water's height is classified per cell: tillable (grass/dirt
with air or a plant above, or under a one-block grass bank that gets dug off), water,
farmland, build, protected, other; a 3-block ring around it is scanned for placed blocks and
farmland. `scoreSite` rejects protected cells, builds or farmland nearby and sites with fewer
than 8 tillable cells (a strip along a shore is fine); the score is tillable cells minus half the extra water minus
distance/8. Within `spawnClearance` of the world spawn counts as protected, because the server
protects spawn before the bot has learned the zone.

## Trade-offs

- Village farm detection is "a villager within 24 blocks of the crops". A player's field next
  to a village could be taken; fields without villagers never are.
- A farm feeds the bot only after the crops grow (tens of minutes), so start_farm is the last
  step and reports that it is still hungry.
- `breed` keeps feed state in memory per session (5.5 minute breeding cooldown).
