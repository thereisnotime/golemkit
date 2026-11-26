# safe-mining Specification

## Purpose
How a bot mines without dying underground: readiness before going deep, no caves, light in the tunnel, and a retreat up when a fight turns (`src/skills/minePlan.ts`, used by mining.ts, gather.ts, progression.ts and the reflexes). Settings live in `settings.mining` and the `mining.*` live toggles.

## Requirements

### Requirement: Readiness gate
With `mining.safe` on (default), a bot SHALL be ready to mine deep only when it has a sword or axe (`needWeapon`, default on), at least `minFood` food items (default 3), and the gear `gear` asks for (`none` default, `shield_or_armour`: a shield or `minArmour` armour points worn, `armour`: `minArmour` points). A bot that is not ready SHALL NOT dig, walk to or collect blocks more than `safeDepth` (default 8) below its surface level or under more than `safeDepth` blocks of ground, and SHALL NOT prospect with a staircase.

#### Scenario: Pax with stone tools and no armour
- **WHEN** Pax (gear shield_or_armour, minFood 4) holds stone tools and cooked beef, wears no armour, has no shield, and the only iron ore in sight is in a cave 60 blocks down
- **THEN** upgrade_tools does not go for it and fails with "not ready to mine: no shield or armour; ..." and data.need = 'gear'

#### Scenario: Shallow ore
- **WHEN** a bot that is not ready sees iron ore with an open face 3 blocks below the surface
- **THEN** it mines it

### Requirement: No retry loop when not ready
keep_tools_upgraded SHALL not pick a step whose only way on is deeper than the safe depth while the bot is not ready. After upgrade_tools fails not ready, its failure back-off SHALL end as soon as what is missing changes.

#### Scenario: Food arrives
- **WHEN** keep_tools_upgraded failed with "not ready to mine: food 1/3" and keep_fed then brings 5 bread
- **THEN** keep_tools_upgraded runs again on the next tick

### Requirement: Shield first
With `gear: shield_or_armour` and neither a shield nor armour, the tool planner SHALL craft a shield from the first iron ingot (with 6 planks of one kind) before any iron tool.

#### Scenario: First ingot
- **WHEN** the bot has stone tools, 1 iron ingot, 10 oak planks and no shield, with gear shield_or_armour
- **THEN** the next step is to craft a shield

### Requirement: Safe staircase
The staircase and strip miner SHALL never dig straight down, SHALL stop at `safeDepth` below the surface with the not-ready reason when the bot is not ready, and SHALL treat as unsafe any step that breaks a block next to an air pocket below the surface (not its own tunnel, not air with full sky light) or stands on a floor with air under it.

#### Scenario: Cave next to the tunnel
- **WHEN** the next block of the strip has cave air beside it
- **THEN** the bot turns to another direction instead of breaking into the cave

### Requirement: Torches
With `mining.torches` on (default), the miner SHALL place a torch on the tunnel floor behind it every `torchEvery` (default 8) steps below the surface when the spot has block light under 8, crafting torches from coal or charcoal and a stick when it has none.

#### Scenario: Coal from the strip
- **WHEN** the bot has mined coal and holds sticks but no torches, 8 steps into the tunnel
- **THEN** it crafts torches and places one behind it

### Requirement: Underground retreat
Underground, at or below `mining.retreatBelow` health (default 10), with `mining.retreatHostiles` (default 2) hostiles within `mining.hostileRadius` blocks (default 8, a live toggle), or with 6 air or less, the miner SHALL abandon the dig and walk back up the way it came, collect SHALL stop and climb out, and the reflexes SHALL run climb_out instead of defend (also with no mob near while health keeps dropping), whatever reflexes.retreatBelow says. A melee mob right on the bot at its level MAY still be fought (keepClimbing). On the surface these rules SHALL NOT apply.

#### Scenario: Flooded cave
- **WHEN** the bot collecting iron ore at y 33 is under water with 4 air left
- **THEN** it stops collecting and climbs out

#### Scenario: Creeper and zombie in a cave
- **WHEN** the bot is at y 10 under 50 blocks of rock with 8 health and a creeper and a zombie 5 blocks away
- **THEN** it climbs out instead of fighting

### Requirement: Opting out
`upgrade_tools safe=false`, `keep_tools_upgraded { safeMining: false }` and `mining.safe false` SHALL turn the rules off for that call, behaviour or bot.

#### Scenario: Owner turns it off
- **WHEN** an owner runs `!config_set mining.safe false`
- **THEN** the bot prospects and goes for deep ore without the readiness check

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

### Requirement: Night down the mine
stay_safe SHALL NOT send the bot home for the night while dig_mine runs. A trip taken over (a reflex, a fight) SHALL still be recorded on the mine. The mine site check SHALL judge only stairs it dug (the first three stair steps it stood on) and SHALL say nothing for a mine with no stairs yet.

#### Scenario: Dusk at y 16
- **WHEN** night falls while the bot is branch mining at y 16
- **THEN** it carries on until a trip limit and walks up the stairs itself
