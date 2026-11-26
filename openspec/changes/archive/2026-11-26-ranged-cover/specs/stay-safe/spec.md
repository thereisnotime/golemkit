## MODIFIED Requirements

### Requirement: Build cover
When the bot hides from shooters, finds no cover within 8 blocks, may place blocks (settings.canPlace) and carries a filler block, it SHALL place blocks where it stands so that a block is on the line from its head and chest to every shooter's eyes: a wall in the cells around it (a 1x2 wall against one shooter on flat ground), or a 1-2 block pillar with a wall on top when that is cheaper or the ground around won't take blocks. It SHALL prefer cobblestone and dirt over logs and planks. Before placing it SHALL stop, wait (briefly) to stand still on the ground and plan the wall again from there. Snow layers, grass and ferns SHALL be cells it places into and never blocks it places against; snow of 2 or more layers SHALL only be used when it may dig it out first. It SHALL never place in a cell its body overlaps or in a protected area, SHALL place each block against one already there, SHALL use at most 6 blocks, SHALL log that it builds cover and, when the wall fails, why, and SHALL then hide behind the wall as behind found cover. Only when it can't build or dig in SHALL it look for cover up to 14 blocks out and then back off.

#### Scenario: Skeleton on open ground
- **WHEN** a skeleton 12 blocks east shoots at a hurt bot on flat open ground and the bot carries cobblestone
- **THEN** it places 2 cobblestone in the cells east of it at feet and head height, logs "building cover", and stays behind them

#### Scenario: Two shooters on opposite sides
- **WHEN** shooters stand east and west of the bot on open ground
- **THEN** the plan walls both sides (4 blocks) and every head and chest line is blocked

#### Scenario: Placing not allowed
- **WHEN** settings.canPlace is false or the cells around it are in a protected area
- **THEN** it builds nothing there and digs in or backs off instead

#### Scenario: Body over the edge of its cell
- **WHEN** the bot stands at the east edge of its block so its body overlaps the next cell
- **THEN** the wall goes one cell further out

#### Scenario: Snow on the ground
- **WHEN** the bot stands on snowy ground with a snow layer in every cell at its feet
- **THEN** the wall goes into the snow cells, each block placed against the ground or a block already placed, never against snow

#### Scenario: Logs and cobblestone
- **WHEN** the bot carries 30 spruce logs and 12 cobblestone
- **THEN** it builds with cobblestone

### Requirement: Heavy fire
Under heavy fire (3 or more shooters or patrol mobs and a gear score under what that many need, or 8 health or less) the bot SHALL take whichever of cover, a wall where it stands or digging in leaves it the shortest time in the open (cover: distance / 5 blocks per second; wall: 0.45 s per block, 0.6 s per pillar block; digging in: the dig time + 0.35 s + 0.45 s per block around the hole), as long as that time x shooters x 0.3 hits per shooter per second is under 3 expected hits. Otherwise it SHALL back off out of sight, sprinting, up to 48 blocks from where the shooting started, towards home when home lies within 100 degrees of straight away from the shooters. The slowest way of hiding SHALL only be used when it can't back off further. A cover spot where it is hit from range SHALL be left at once and not used again in that fight. With a shield it SHALL block an incoming arrow while backing off when at 12 health or less or facing at most 2 shooters, at most every 1.5 s. The rules SHALL be pure (heavyFire, wallSeconds, digInSeconds, fleePoint, shieldWhileFleeing in `src/skills/ranged-plan.ts`).

#### Scenario: Three skeletons, stone sword
- **WHEN** three skeletons shoot at a bot with a stone sword, no armour and no shield, nothing to build or dig with, and the nearest cover is 9 blocks away
- **THEN** it walks to the cover (about 1.6 expected hits) instead of backing off in the open

#### Scenario: Three pillagers, cover 7 or 15 blocks off
- **WHEN** three pillagers shoot at a bot with stone tools, no armour and no shield, the nearest cover is 7 or 15 blocks away and a 2-block wall fits where it stands
- **THEN** it builds the wall there and logs "heavy fire, building here (cover 7 blocks off is too slow)"

#### Scenario: Digging in
- **WHEN** the same bot has no blocks, may dig, and stands on dirt over stone with cover 15 blocks off
- **THEN** it digs in

#### Scenario: Nothing quick
- **WHEN** the same bot has no blocks, may not dig, and the nearest cover is 20 blocks away
- **THEN** it backs off out of sight, towards home when home lies away from the shooters, and logs "heavy fire, getting out of sight"

#### Scenario: Cover right there
- **WHEN** the same bot has cover 3 blocks away
- **THEN** it takes that cover

#### Scenario: Hit behind cover
- **WHEN** the bot is hit by an arrow while holding a cover spot
- **THEN** it leaves the spot and does not use it again

## ADDED Requirements

### Requirement: Dig in
When digging is allowed (agent.canDig and the ranged_defense `digIn` option, default on), the bot MAY hide by digging the block under its feet and standing in the 1-block hole, placing a block or two toward the shooters around it when the hole alone doesn't cover its head and chest. It SHALL NOT dig in on ice, ore, obsidian, bedrock, farmland or a base block (bed, chest, workstation), on a floor in a protected area, over a block that is not solid (a drop, the void), over lava, water, magma or fire, when water or lava is beside the hole or at its feet, or when the floor takes more than 1.5 s to dig. The check SHALL be pure (digInRefusal in `src/skills/ranged-plan.ts`).

#### Scenario: Water beside the hole
- **WHEN** the block beside the floor block is water
- **THEN** it does not dig in

#### Scenario: Frozen lake
- **WHEN** the bot stands on ice
- **THEN** it does not dig in

### Requirement: Hiding hysteresis
The bot SHALL keep a way of hiding (cover, a wall, digging in, backing off) for at least the ranged_defense `commitSeconds` (default 2) before switching to another, unless it is no longer possible or the bot turns to fight back, and SHALL log a change of plan once instead of on every pass.

#### Scenario: Cover distance changes while backing off
- **WHEN** the bot backs off and a pass later finds cover 7 blocks off, then 15
- **THEN** it keeps backing off for at least 2 s and logs one line
