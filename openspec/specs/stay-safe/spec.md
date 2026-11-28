# stay-safe Specification

## Purpose
How stay_safe and go_home decide the bot is home at night, how the bot deals with mobs shooting at it, and how the NPC controller keeps a flickering behaviour from restarting every few seconds.

## Requirements

### Requirement: Home measured with vertical slack
The bot SHALL count as home when its distance to the middle of the home block, counting only the part of the height difference beyond 3 blocks, is within the range (`homeOffset` in `src/skills/navigation.ts`); `go_home` SHALL succeed at once without pathing when the bot is already within its range by that measure.

#### Scenario: Inside the base, a floor up
- **WHEN** the bot stands 2 blocks from home and 2 blocks higher and go_home runs with range 4
- **THEN** go_home returns "already home" and does not start the pathfinder

#### Scenario: Below the base
- **WHEN** the bot stands 7 blocks below and 6 blocks beside home with homeRange 8
- **THEN** stay_safe does not send it home

### Requirement: Night hysteresis
stay_safe SHALL start heading home at night when the bot is farther than homeRange, SHALL keep going until it is within go_home's range (homeRange, at most 4), and for 3 minutes after arriving SHALL only head home again beyond homeRange + 4.

#### Scenario: Walking back
- **WHEN** stay_safe is taking the bot home and it is 6 blocks out with homeRange 8
- **THEN** stay_safe still applies

#### Scenario: Chore after arriving
- **WHEN** the bot got home a minute ago and a chore takes it 9 blocks out
- **THEN** stay_safe does not send it home

### Requirement: go_home back-off
After a failed go_home, stay_safe SHALL not try go_home again for 60 s, doubling per failure in a row up to 5 minutes; meanwhile an unprepared bot SHALL shelter (bunker, where allowed) or stand guard in place, and more urgent dangers SHALL still apply.

#### Scenario: Unreachable home
- **WHEN** go_home fails at night
- **THEN** stay_safe holds position for 60 s before trying again

### Requirement: Stale path stop retried once
A path stopped within the first 1.5 s SHALL be started once more; a second stop SHALL be reported as the path being stopped repeatedly.

#### Scenario: Previous action's stop lands late
- **WHEN** go_home's first path is stopped right away and the second attempt walks
- **THEN** go_home succeeds

### Requirement: Flip back-off
A behaviour whose run drops out ("no longer applies") within 10 s of starting SHALL, from the second such flip in a row, only start again with a score of at least `flipBypassScore` (default 75) for 5 s, doubling per flip up to 60 s; a run that finishes by itself SHALL reset the count.

#### Scenario: Flickering condition
- **WHEN** stay_safe started and dropped out twice within a few seconds each
- **THEN** a score of 70 does not start it again for 5 s, but a score of 90 does

### Requirement: find_food leaves water instead of retrying
When a find_food leg fails because the bot kept running out of air under water, it SHALL swim to dry land nearby and stop scouting instead of starting another leg from the same spot.

#### Scenario: Lake bed
- **WHEN** a scouting leg ends with "kept running out of air under water"
- **THEN** the bot heads to the nearest dry spot and find_food reports that reason

### Requirement: Ranged threats
Every bot with reflexes or stay_safe SHALL notice mobs that shoot at it (skeletons, strays, bogged, pillagers, witches, blazes, ghasts, drowned holding a trident) within 24 blocks with a line of sight, projectiles on course for it (arrows, bolts, potions, tridents, fireballs) and hits from range, and SHALL answer by health and gear: shoot back with a bow or crossbow and arrows, raise a shield and close in, charge a lone shooter when healthy and armed, or take cover behind a block (a spot with a solid block between it and every shooter) and back out of range when there is none. At 8 health or less, or against 3 or more shooters (or a pillager patrol of 3+) with a gear score below what that many need (see Graded gear), it SHALL take cover or back off instead of fighting, and SHALL eat only out of the shooters' sight. The reflex SHALL preempt whatever job runs (find_food, find_target, chop_wood_loop), and stay_safe SHALL score cover above keep_fed when hurt (12 or less) or outnumbered.

#### Scenario: Starving bot shot by a pillager while scouting
- **WHEN** a bot at food 0 walks on a find_food leg and a pillager with a line to it hits it with a bolt
- **THEN** the health drop counts as a ranged hit (not starvation), find_food is preempted and the bot answers the pillager

#### Scenario: Arrow on course
- **WHEN** an arrow is flying at the bot's body before it lands
- **THEN** the bot starts ranged_defense before the hit

#### Scenario: Patrol without armour
- **WHEN** three pillagers have a line to a bot with a sword and a shield but no armour
- **THEN** it takes cover behind a block if one is within 8 blocks, else builds cover if it can, else backs out of range

#### Scenario: Bow and arrows
- **WHEN** one skeleton 12 blocks away shoots at a healthy bot that carries a bow and arrows
- **THEN** it shoots back

#### Scenario: Low health
- **WHEN** a skeleton has a line to the bot at 6 health
- **THEN** the bot goes behind cover and eats there, not in the open

#### Scenario: Bodyguard
- **WHEN** the bot escorts a player above 8 health
- **THEN** stay_safe leaves archers to protect

### Requirement: Graded gear
The fight-or-hide decision against 3 or more shooters (or a patrol of 3+) SHALL use a gear score from 0 to 100 made of armour points (up to 35), a shield (20), the best melee weapon's damage (up to 15), a bow or crossbow with arrows (up to 15, nothing without arrows) and health (up to 15). The bot SHALL fight when the score reaches 65 for 3 shooters plus 5 for each one more, and hide otherwise; stay_safe's ranged danger SHALL use the same score.

#### Scenario: Iron and a shield against four
- **WHEN** four pillagers have a line to a bot at full health with iron armour, a shield and an iron sword
- **THEN** it raises the shield and closes in

#### Scenario: The same gear against five, or hurt
- **WHEN** five pillagers have a line to that bot, or four do and it is at 14 health
- **THEN** it hides

#### Scenario: A bow without arrows
- **WHEN** the bot carries a bow but no arrows
- **THEN** the bow adds nothing to its gear score

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

### Requirement: Hide time and retreat cap
Behind cover the bot SHALL leave as soon as every shooter is gone or, at 16 health or more, nothing shoots at it, and SHALL stay at most 4 s at 16+ health, 8 s at 12+ and 15 s below. After a fight against shooters that went badly it SHALL hide 3 s at 16+ health, 6 s at 12+, 10 s above 8 and 15 s at 8 or less, and stop hiding early when at 16+ health no shooter has a line to it. Backing off SHALL stop 24 blocks from where the shooting started (48 under heavy fire); at that cap it SHALL stand its ground with a bow, shield or weapon, except at 8 health or less or with nothing to fight with, where it MAY back off up to 16 blocks more.

#### Scenario: Healthy after a bad fight
- **WHEN** a charge at a skeleton is broken off and the bot is back to 18 health with the skeleton out of sight
- **THEN** it stops hiding at once instead of after 15 s

#### Scenario: Long retreat
- **WHEN** the bot backs off from a patrol and is already 24 blocks from where the shooting started
- **THEN** it doesn't back off further; it hides, builds cover, or raises its shield

### Requirement: Danger-zone memory
Every shooter the bot deals with SHALL be remembered as a danger zone at its position, with a radius of its range plus 8 blocks, for 5 minutes after the last sighting, and a patrol of 3 or more at its middle with a radius of 32 for 10 minutes; seeing the same kind there again SHALL refresh the zone, and killing the only shooter there SHALL clear it. find_target SHALL skip scouting waypoints inside a zone or whose straight path crosses one, and chop_tree (used by chop_wood_loop) SHALL skip trees in or past one. Pure helpers (isInDanger, avoidZones, crossesDanger) and a per-agent memory (dangerMemory) SHALL be exported from core for other jobs such as find_food.

#### Scenario: Back to work after a patrol
- **WHEN** the bot hid from a pillager patrol 50 blocks east two minutes ago and find_target scouts again
- **THEN** waypoints within 32 blocks of the patrol, and those whose path runs through it, are skipped

#### Scenario: Zone expires
- **WHEN** a skeleton's zone was last refreshed 6 minutes ago
- **THEN** it no longer counts and trees there may be chopped

#### Scenario: Killed the shooter
- **WHEN** the bot kills the only skeleton shooting at it
- **THEN** that skeleton's zone is cleared

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

### Requirement: Out of a sealed pit before walking
Before walking, `goto` and `go_home` SHALL climb out when the bot is boxed in (solid on all four sides at feet and head level with a solid block within 3 above) by day. At night they SHALL stay in the pit and fail with the reason instead.

#### Scenario: interrupted bunker
- **WHEN** the bot is at the bottom of its sealed 3-deep bunker by day and stay_safe calls go_home
- **THEN** it digs the lid, climbs out, then walks home

#### Scenario: interrupted bunker at night
- **WHEN** the same happens at night
- **THEN** go_home fails with "sheltered in a sealed pit, staying until morning" and the bot stays put

#### Scenario: a room with a door
- **WHEN** the bot stands in a small room with an open doorway
- **THEN** it walks out normally without digging up

### Requirement: Air loop escape
When the air action runs `reflexes.airLoopRuns` times within `airLoopMinutes` and `airLoopRadius` blocks, the bot SHALL dig out to open sky after getting air instead of staying in the water.

#### Scenario: flooded pocket under a roof
- **WHEN** the bot needed air three times in the same pocket within three minutes
- **THEN** after the next breath it climbs out to the sky
