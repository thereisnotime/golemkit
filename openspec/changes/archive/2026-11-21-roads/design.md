# Design: roads and staircases

## Height map

`RoadTerrain` holds, per column of the search box, the natural ground height (top natural block,
seen through plants, snow and leaves) and flags: `BLOCKED` (player-made blocks, trees, protected
areas, the spawn keep-out, unloaded columns), `MARGIN` (one cell around player builds),
`LIQUID` (water/lava, ground = the surface), `ROAD` (an existing road lane, with its walking
height and stair facing) and `RAIL` (an existing railing). The world scan uses block state ids
directly (no Block objects) so a 200x200 box reads in well under a second. Roads this bot built
are read from storage, not from the blocks, so their natural ground stays known.

## Search state

`(x, z, f, heading, trend, sinceTurn, sinceChange)`; `f` is the walking (feet) height, the road
block is at `f - 1`.

- Moves: straight, or a quarter turn left or right. A turn needs `sinceTurn >= minSeg` (width + 1,
  at least `straight` from a door) and `sinceChange >= landing` (landing = half width + 1), and the
  turn cell's landing square (width x width, ring of railings) must fit.
- Height: `f` changes by one only on straight moves and only when `sinceTurn > landing`, so the
  rows covered by a landing square are flat. A change against the trend (up then down) needs a
  landing in between and costs `bumpCost` (or is refused with `monotone`).
- Cost per step: 1 + cut/fill per lane (`cutFillWeight * min(|f - 1 - ground|, costCap)`, hard
  `maxCut`/`maxFill`) + `turnCost` + half the landing square + `riseCost` + `bumpCost`, bridge
  cost over liquid.
- Width: every lane must be free of `BLOCKED`, `MARGIN` (except the straight stub in front of a
  door), `ROAD`, `RAIL` (except right before a junction) and liquid (unless bridging); railing
  cells must not be `BLOCKED` or another road.
- Junctions: the route ends when the next cell ahead is a flat target road cell at the same height
  whose neighbours across the new road are flat at that height too; it may start from such a cell.
- Self-overlap: on expansion the ancestors are walked; a cell closer than width + 1 (Chebyshev) to
  an ancestor more than twice that distance back along the route is refused. Two flights of a
  switchback are exactly width + 1 apart (one gap cell for a shared railing), so they pass; a road
  crossing over or under itself or doubling back alongside does not. The closed set doesn't
  remember history, so this is a heuristic: a refused state is reopened for other paths.
- Heuristic: a BFS distance to the targets around blocked cells, times `heuristicWeight` (1.2),
  plus the height difference for a single target with a known height.
- Limits: the search box (endpoints + 24, at most 224 per side), `maxNodes` (400k). A quick
  check that any target is arrivable at all makes impossible plans fail fast. Every failure says
  why (which rule stopped it most).

## Why switchbacks emerge

A flight can't change height on a landing or for `landing` cells after a turn, and the cut/fill
limits stop a flight from climbing faster than the ground allows. When the endpoints are closer
than the rise needs, the cheapest way to get the length is two turns in the same direction with a
`width + 1` connector: a 180 degree turn on two landings with a one-cell gap between the parallel
flights. Nothing in the code builds a switchback on purpose.

## Even gradients

After the search, each straight flight (between landings) that only goes one way gets its rises
spread evenly over the steps that may change height, when every lane stays within the limits and
the cut/fill grows by at most `gradientSlack` per cell.

## Geometry

`roadGeometry(route, terrain, { width, palette, lanterns, maxBase })` returns the surface cells,
railings, blocks in build order (per row: base bottom-up, floor or stair, railing; lanterns last),
the cells to clear (head-room `f..f+2` and any cut up to the ground), conflicts (none expected) and
stats (length, stair rows, landings, max cut/fill, materials). A stair goes on the higher cell of
each one-block rise, facing the way up, on every lane of that row. Turn rows are full squares.
Railings stand beside lanes (and round landings) where `f - 1 - ground >= 2`, or over liquid, on a
base down to the ground; where two flights share a gap cell the higher one sets its height.
Cells of an existing road are never written (the junction blends in). `geometryProblems` checks a
route against its geometry: neighbours, at most one block per step, flat landings, every lane at
the row's height, every rise with its stair facing up.

## Networks

`connect(terrain, ends, opts, geo, existing)` starts with one group per door (and one per existing
road network) and repeatedly lays the cheapest planned road between two groups. Plans are made
between each group and its three nearest groups first (all pairs only when none of those works),
with a node budget growing with the distance (a full-budget retry when nothing else works). A
group whose door is used has no free doors; it is joined through its roads. After a road is laid
the terrain marks it `ROAD`/`RAIL`, and cached plans involving the joined groups or passing near the
new road are made again.

## Building

Survival: what isn't in place yet is counted; `gather_materials` makes the stone bricks, stairs
and walls (stone recipes, smelting) and mines cobblestone; then row by row from the start: clear
head-room top-down (natural blocks and road blocks only, never anything else, never in protected
areas), then the row's blocks with `placeBlockState` (stairs get their facing from the placement
planner). Creative: the same by hand with the creative item pick and hand delay, or with commands
(`planCommands`: air runs, then the blocks bottom-up merged into `/fill` boxes, lanterns last;
falls back to hand without op). Afterwards `walkCheck` reads the road back. The result names
blocks placed, already there, cleared, left alone, unreachable, missing materials, op commands, and
walkability problems.

## Storage

`road.built` keeps each road's route, surface (with natural ground), railings, the blocks placed
and the blocks dug out. `remove_road` breaks only blocks that are still what it placed and, in
creative, puts natural ground back; the record stays (marked removed) so `build_road redo=<id>`
builds the same line again.

## Core changes

Only `src/core/toggles.ts`: five `road.*` toggles. Everything else is in skills.
