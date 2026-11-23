# stay-safe Specification

## Purpose
How stay_safe and go_home decide the bot is home at night, how the bot deals with mobs shooting at it, and how the NPC controller keeps a flickering behaviour from restarting every few seconds.

## Requirements

### Requirement: Home measured with vertical slack
The bot SHALL count as home when its horizontal distance to the home block, plus any height difference beyond 3 blocks, is within the range; `go_home` SHALL succeed at once without pathing when the bot is already within its range by that measure.

#### Scenario: Inside the base, a floor up
- **WHEN** the bot stands 2 blocks from home and 2 blocks higher and go_home runs with range 4
- **THEN** go_home returns "already home" and does not start the pathfinder

#### Scenario: Below the base
- **WHEN** the bot stands 7 blocks below and 7 blocks beside home with homeRange 8
- **THEN** stay_safe does not send it home

### Requirement: Night hysteresis
stay_safe SHALL start heading home at night when the bot is farther than homeRange, SHALL keep going until it is within go_home's range, and for 3 minutes after arriving SHALL only head home again beyond homeRange + 4.

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
When the bot hides from shooters, finds no cover within 8 blocks, may place blocks (settings.canPlace) and carries a filler block (dirt, cobblestone, planks, stone, logs), it SHALL place blocks where it stands so that a block is on the line from its head and chest to every shooter's eyes: a wall in the cells around it (a 1x2 wall against one shooter on flat ground), or a 1-2 block pillar with a wall on top when that is cheaper or the ground around won't take blocks. It SHALL never place in a cell its body overlaps or in a protected area, SHALL place each block against one already there, SHALL use at most 6 blocks, SHALL log that it builds cover, and SHALL then hide behind the wall as behind found cover. Only when it can't build SHALL it look for cover up to 14 blocks out and then back off.

#### Scenario: Skeleton on open ground
- **WHEN** a skeleton 12 blocks east shoots at a hurt bot on flat open ground and the bot carries cobblestone
- **THEN** it places 2 cobblestone in the cells east of it at feet and head height, logs "building cover", and stays behind them

#### Scenario: Two shooters on opposite sides
- **WHEN** shooters stand east and west of the bot on open ground
- **THEN** the plan walls both sides (4 blocks) and every head and chest line is blocked

#### Scenario: Placing not allowed
- **WHEN** settings.canPlace is false or the cells around it are in a protected area
- **THEN** it builds nothing there and backs off instead

#### Scenario: Body over the edge of its cell
- **WHEN** the bot stands at the east edge of its block so its body overlaps the next cell
- **THEN** the wall goes one cell further out

### Requirement: Heavy fire
Under heavy fire (3 or more shooters or patrol mobs and a gear score under what that many need, or 8 health or less) the bot SHALL take cover only when the spot can be reached before about one hit is expected (distance / 5 blocks per second x shooters x 0.3 hits per shooter per second under 1), and build cover only when the wall can be finished as fast (0.45 s per block, 0.6 s per pillar block). Otherwise it SHALL back off out of sight, sprinting, up to 48 blocks from where the shooting started, towards home when home lies within 100 degrees of straight away from the shooters. Slow cover or a slow wall SHALL only be used when it can't back off further. A cover spot where it is hit from range SHALL be left at once and not used again in that fight. With a shield it SHALL block an incoming arrow while backing off when at 12 health or less or facing at most 2 shooters, at most every 1.5 s. The rules SHALL be pure (heavyFire, quickCover, quickWall, fleePoint, shieldWhileFleeing in `src/skills/ranged-plan.ts`).

#### Scenario: Three skeletons, stone sword
- **WHEN** three skeletons shoot at a bot with a stone sword, no armour and no shield, and the nearest cover is 9 blocks away
- **THEN** it backs off out of sight instead of walking to the cover, and logs "heavy fire, getting out of sight"

#### Scenario: Cover right there
- **WHEN** the same bot has cover 3 blocks away
- **THEN** it takes that cover

#### Scenario: Hit behind cover
- **WHEN** the bot is hit by an arrow while holding a cover spot
- **THEN** it leaves the spot and does not use it again

### Requirement: Hide time and retreat cap
Behind cover the bot SHALL leave as soon as every shooter is gone or, at 16 health or more, nothing shoots at it, and SHALL stay at most 4 s at 16+ health, 8 s at 12+ and 15 s below. After a fight against shooters that went badly it SHALL hide 3 s at 16+ health, 6 s at 12+, 10 s above 8 and 15 s at 8 or less, and stop hiding early when at 16+ health no shooter has a line to it. Backing off SHALL stop 24 blocks from where the shooting started; at that cap it SHALL stand its ground with a bow, shield or weapon, except at 8 health or less, where it MAY back off up to 16 blocks more.

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
