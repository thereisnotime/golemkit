## ADDED Requirements

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
