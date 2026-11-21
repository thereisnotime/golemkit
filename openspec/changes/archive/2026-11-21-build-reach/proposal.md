# Builds that don't wait on unreachable spots, climbs that survive a fight

## Why

Pax's fortress build (17x17, floor at ground level, a hut standing inside) logged "stand spot
unreachable ... took too long to get there" 57 times in 25 minutes and placed very few blocks.
The travel back from gathering had stopped 34 blocks away in a cave, every stand spot then got a
15 s walk, every placement tried up to five clicked blocks with four spots each, spots under the
floor and inside the hut were picked, and failed spots were tried again for the next block.

Later Pax was underground; `goto` started climbing out, a reflex fight preempted it, the climb
reported "couldn't climb out (aborted)" as a failure, and the bot died fighting a skeleton in
the cave.

A creative build of the same fortress hung for minutes: mineflayer's `creative.flyTo` flies
through terrain and then waits for a move event with no timeout.

## What changes

- Stand spots: only standable cells, ranked by distance with penalties for below the target
  level, sealed pockets and unbuilt cells; spots under a foreign roof are ruled out; failed
  spots are cached per build; 4 to 8 s path budget per spot, three spots per clicked block, two
  clicked blocks walked to per cell; options in reach from here first.
- Build: travel to the site first and fail early when that doesn't work; batch placements
  (nearest ready cell in reach within the layer); order seeds from what stands in the world;
  the quality pass skips blocks that already failed for reach; pathfinder search radius 32.
- `goto` rethrows an aborted climb (preempted, resumed later) and climbs twice before giving up.
- Reflexes don't fight or retreat while climbing out unless a melee mob is on the bot or a
  creeper is close.
- Creative: own `flyNear` (up, across, down, never into a block, time limit, honours the
  signal); creative stock has a per-slot timeout and counts what arrived.
