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
Underground, at or below `mining.retreatBelow` health (default 10) or with `mining.retreatHostiles` (default 2) hostiles within `hostileRadius` (8), the miner SHALL abandon the dig and walk back up the way it came, and the reflexes SHALL run climb_out instead of defend, whatever reflexes.retreatBelow says. A melee mob right on the bot at its level MAY still be fought (keepClimbing). On the surface these rules SHALL NOT apply.

#### Scenario: Creeper and zombie in a cave
- **WHEN** the bot is at y 10 under 50 blocks of rock with 8 health and a creeper and a zombie 5 blocks away
- **THEN** it climbs out instead of fighting

### Requirement: Opting out
`upgrade_tools safe=false`, `keep_tools_upgraded { safeMining: false }` and `mining.safe false` SHALL turn the rules off for that call, behaviour or bot.

#### Scenario: Owner turns it off
- **WHEN** an owner runs `!config_set mining.safe false`
- **THEN** the bot prospects and goes for deep ore without the readiness check
