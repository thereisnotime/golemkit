## ADDED Requirements

### Requirement: Its own staircase mine
`dig_mine` SHALL dig or reuse a mine near home with these rules. Readiness: a weapon (`mining.needWeapon`), `mining.minFood` food, `mine.minHealth` (14) health and the gear `mine.gear` asks for (default none); not ready, it SHALL fail with the missing items and `data.need`. Entrance: within `mine.radius` (32) and at least `mine.minFromHome` (8) blocks of home, no water, ice or lava within 3 blocks, nothing solid overhead, not on a farm, not in a protected area or spawn protection, and the first 4 steps down planned safely; else it SHALL fail saying why spots were refused. Stairs: 1 wide, 2 high, one down per step forward, every step through `planStep` with the cave check, down to `mine.depthY` (16) and at least 6 above the world floor. At depth: a main tunnel with a branch on each side every `mine.branchSpacing + 1` blocks, `mine.branchLength` long, at most `mine.maxBranches` pairs per trip. It SHALL mine the `mine.ores` blocks touching the tunnel and their veins when its pickaxe tier allows, unless the ore touches lava or water or would open a cave. Torches as safe mining says. It SHALL head back up the stairs when it has the ore it came for, after `mine.minutes`, with fewer than `mine.minFreeSlots` free slots, out of food or pickaxes, or when the underground retreat says so.

#### Scenario: Pax with stone tools
- **WHEN** Pax (mining.gear shield_or_armour) has stone tools, 12 cooked beef, 20 health and no armour
- **THEN** dig_mine goes down its own mine, while upgrade_tools still refuses cave ore deeper than the safe depth

#### Scenario: Frozen lake by home
- **WHEN** every spot within 12 blocks of home is next to ice
- **THEN** the entrance goes on dry ground further out, within 32 blocks

### Requirement: Mines remembered
A mine SHALL be remembered in agent storage (`mines`) with its entrance, direction, the foot of the stairs, the face of the main tunnel, every 4th stair step, branches, torches and what it got. The next trip, `mine.cooldownMinutes` after the last, SHALL walk down to the face and carry on. The site check `mine` SHALL mark a mine flooded with water in its first stair steps, unsafe with lava there, gone when they are filled in, and unreachable after the walk down failed `sites.failures` times; a bad mine SHALL be skipped and the next trip SHALL dig a new one. A mine with about one torch per `mining.torchEvery` stair steps SHALL count as lit.

#### Scenario: Second trip
- **WHEN** the bot dug mine:1 to y 16 with two branch pairs and goes again 30 minutes later
- **THEN** it walks down mine:1's stairs to the face and digs the next branches
