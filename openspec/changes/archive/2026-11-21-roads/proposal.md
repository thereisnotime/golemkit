# Roads and staircases between buildings

## Why

Owners want bots to join their buildings with roads that look built by a person, on very
uneven ground (a village site goes from y 65 to 120 within 50 blocks). One-off scripts that tried
fixed route shapes (L-shapes, detours, zig-zags) against hard rules rejected almost everything on
that site, and a plain A* with free up and down steps gave bumpy, messy stairs. The bots need a
real planner they can use for any site.

## What changes

- New pure planner `src/skills/road-plan.ts`: a height map with blocked cells, liquids and
  existing roads; A* over position, walking height, heading, vertical trend and the steps since the
  last turn and height change. Height changes only on straight moves, turns only on flat landings,
  a heavy cost for up-then-down, cut and fill limits for every lane, the whole width (lanes plus
  railings) clear of buildings, no overlap with other roads except a T-junction at the same height,
  and no overlap with itself. Switchbacks come out of the search when the slope is steeper than one
  block per block. Afterwards each straight flight gets an even gradient when that costs little.
- One geometry function for building and checking: floor, stairs (on the higher cell of each rise,
  facing up, the same on every lane), landing squares, base down to the ground, cut and head-room,
  wall railings on drops of 2 or more, optional lanterns on landing posts, junctions blended into
  the old road.
- `connect`: joins many door fronts cheapest-first (Kruskal on planned costs, re-planned as roads
  are laid), each door straight out for a few cells, later roads joining earlier ones at T-junctions.
- New `roads` skill (in the extended skills): `build_road`, `connect_buildings`, `remove_road`,
  `road_list`. Survival gathers stone bricks and cobblestone and places by hand; creative builds by
  hand or with merged `/fill` runs. Roads are remembered (`road.built`) for removal and redo.
- `build` records finished structures (`build.placements`: template, box, facing, door) so
  `connect_buildings` can find them.
- Toggles `road.width`, `road.palette`, `road.maxCut`, `road.maxFill`, `road.lanterns`.

## Non-goals

- Diagonal roads, curves or slabs for half steps: flights are axis-aligned and rise one block per
  cell at most.
- Tunnels and multi-level crossings: a road never passes over or under another road or itself.
- Restoring dug ground in survival when a road is removed (creative only).
