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
