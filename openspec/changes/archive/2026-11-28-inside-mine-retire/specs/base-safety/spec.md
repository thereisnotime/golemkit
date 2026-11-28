## MODIFIED Requirements

### Requirement: The bot's own mine goes inside its base under a hatch
With `baseSafety.minePlacement: inside` (default) a new staircase mine SHALL start inside the base walls, on a straight line of free floor columns clear of the gate by `mineKeepClear`, the farm plot, the workshop and the storage row, preferring a line along a wall. Its first stair steps MAY dig the base's own floor blocks at that line only; the dig keep-out SHALL hold everywhere else. With `mineHatch` the floor cells the stairs cut SHALL get trapdoors after the first trip (crafted from planks or logs when it has none), and a wooden trapdoor hatch SHALL be opened for a trip and closed after it. With `retireCloseMines` a known mine outside the walls within `mineClearance` of them SHALL be capped and retired, also when it is found capped already. A torch, ladder, rail or similar small block standing in a cap cell SHALL be taken out before the cap is placed (when the bot may dig). With `inside` and `useOutsideMines` off (default), a known mine outside the walls SHALL NOT be used for trips, so the next trip digs the inside mine; when no free spot inside is found, a trip MAY still go down such a mine. A retired mine SHALL NOT be reported unsafe by the site check. `outside` SHALL keep the old placement; `either` SHALL try inside first; with no settled base the mine SHALL start near home.

#### Scenario: First mine in a walled base
- **WHEN** the bot needs a mine, its base is settled and an old mine sits one block outside the east wall
- **THEN** the old mine is capped and retired, a new one starts along a wall inside the base, its stairs cut through the floor there, and a trapdoor hatch covers them after the trip

#### Scenario: Torch in the cap cell
- **WHEN** the mine on the wall has a torch on its first stair step, where the cap goes
- **THEN** the integrity session breaks the torch, places the cap and retires the mine

#### Scenario: Old mine far outside the walls
- **WHEN** placement is inside, the bot needs iron and its only usable mine is 16 blocks outside the walls
- **THEN** the trip digs a new mine inside the walls under a hatch instead of walking out to the old one, unless `useOutsideMines` is on
