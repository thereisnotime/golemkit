# base-safety Specification

## Purpose
TBD - created by archiving change 2026-11-27-base-safety. Update Purpose after archive.

## Requirements

### Requirement: The base is checked for ways in for mobs
The bot SHALL scan the ground under its settled base and `baseSafety.margin` blocks around it, down
to `baseSafety.depth` below the floor, for dark cavities that have an opening to the open air and
either spawn spots or an opening into the footprint, and for known mines whose entrance is inside,
on or within `baseSafety.mineClearance` blocks of the walls.

#### Scenario: Tunnel under the floor
- **WHEN** a dark tunnel runs under the floor with a shaft up into the yard
- **THEN** `check_base` reports a cavity that opens into the base, and the base's site health is `unsafe` with that reason

#### Scenario: Sealed pocket
- **WHEN** a dark pocket under the floor has no opening
- **THEN** it is not a threat

### Requirement: Threats are fixed by configurable techniques
The bot SHALL fix each threat with the techniques in `baseSafety.techniques` order: cap (mine
entrances, with `capWith`), fill (cavities up to `fillMax` that don't go on past the box and hold no
mine), seal (up to `sealMax` openings, never a mine's), light (torches `lightSpacing` apart), and
report what stays unfixed with the reasons. It runs as the base project `integrity` and as
`secure_base`.

#### Scenario: Mine by the wall
- **WHEN** a known mine's entrance is one block outside the walls
- **THEN** its stairs get a trapdoor (or the configured cap) where they cut the ground, the mine record keeps the cap, and its next trip takes the cap off and puts it back

### Requirement: Digging keeps out of the ground under the base
Stone and ore digging SHALL skip blocks under the base footprint and margin down to
`keepOutDepth` below the floor, and a new mine SHALL start outside the walls by more than
`mineClearance` (or inside, with `minePlacement`).

#### Scenario: Stone from home
- **WHEN** the bot needs cobblestone while standing in its base
- **THEN** it walks out past the keep-out before digging down

### Requirement: A death spot is avoided for a while
After a death the bot SHALL remember the spot as a danger zone of kind `death` with
`deathSpots.radius`, `yRange` and `minutes`; paths SHALL cost `stepCost` more per block in it,
`wander` SHALL not pick spots in it and stone digging SHALL not dig there.

#### Scenario: Died in a cave under the base
- **WHEN** the bot dies 4 blocks under its floor and respawns in its bed above
- **THEN** the bed is outside the zone (height band) and its chores don't walk back down for 10 minutes unless there is no other way

### Requirement: Holes in the floor surface are fixed
With `baseSafety.floorHoles` on (default), the scan SHALL also report every open block at floor
level in a column inside the walls that is not part of a cavity, a farm's water or a known mine's
stairs, with the open blocks below it down to the first solid one (at most `depth`), and the
integrity project SHALL fill them bottom up: the floor block in stone when the bot carries some,
dirt in the farm plot kept inside the walls.

#### Scenario: A hole open to the sky
- **WHEN** a floor block inside the walls is missing and the one below it too, both lit by the sky
- **THEN** `check_base` reports a hole in the floor two blocks deep and `secure_base` fills both

#### Scenario: Farm plot
- **WHEN** a cell of the reserved farm plot is empty
- **THEN** it is filled with dirt, not stone

### Requirement: The bot's own mine goes inside its base under a hatch
With `baseSafety.minePlacement: inside` (default) a new staircase mine SHALL start inside the base walls, on a straight line of free floor columns clear of the gate by `mineKeepClear`, the farm plot, the workshop and the storage row, preferring a line along a wall. Its first stair steps MAY dig the base's own floor blocks at that line only; the dig keep-out SHALL hold everywhere else. With `mineHatch` the floor cells the stairs cut SHALL get trapdoors after the first trip (crafted from planks or logs when it has none), and a wooden trapdoor hatch SHALL be opened for a trip and closed after it. With `retireCloseMines` a known mine outside the walls within `mineClearance` of them SHALL be capped and retired. `outside` SHALL keep the old placement; `either` SHALL try inside first; with no settled base the mine SHALL start near home.

#### Scenario: First mine in a walled base
- **WHEN** the bot needs a mine, its base is settled and an old mine sits one block outside the east wall
- **THEN** the old mine is capped and retired, a new one starts along a wall inside the base, its stairs cut through the floor there, and a trapdoor hatch covers them after the trip
