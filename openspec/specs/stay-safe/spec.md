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
A behaviour whose run drops out ("no longer applies") within 10 s of starting SHALL, from the second such flip in a row, only start again with an urgent score (80+) for 5 s, doubling per flip up to 60 s; a run that finishes by itself SHALL reset the count.

#### Scenario: Flickering condition
- **WHEN** stay_safe started and dropped out twice within a few seconds each
- **THEN** a score of 70 does not start it again for 5 s, but a score of 90 does

### Requirement: find_food leaves water instead of retrying
When a find_food leg fails because the bot kept running out of air under water, it SHALL swim to dry land nearby and stop scouting instead of starting another leg from the same spot.

#### Scenario: Lake bed
- **WHEN** a scouting leg ends with "kept running out of air under water"
- **THEN** the bot heads to the nearest dry spot and find_food reports that reason

### Requirement: Ranged threats
Every bot with reflexes or stay_safe SHALL notice mobs that shoot at it (skeletons, strays, bogged, pillagers, witches, blazes, ghasts, drowned holding a trident) within 24 blocks with a line of sight, projectiles on course for it (arrows, bolts, potions, tridents, fireballs) and hits from range, and SHALL answer by health and gear: shoot back with a bow or crossbow and arrows, raise a shield and close in, charge a lone shooter when healthy and armed, or take cover behind a block (a spot with a solid block between it and every shooter) and back out of range when there is none. At 8 health or less, or against 3 or more shooters (or a pillager patrol of 3+) without iron armour and a shield, it SHALL take cover or back off instead of fighting, and SHALL eat only out of the shooters' sight. The reflex SHALL preempt whatever job runs (find_food, find_target, chop_wood_loop), and stay_safe SHALL score cover above keep_fed when hurt (12 or less) or outnumbered.

#### Scenario: Starving bot shot by a pillager while scouting
- **WHEN** a bot at food 0 walks on a find_food leg and a pillager with a line to it hits it with a bolt
- **THEN** the health drop counts as a ranged hit (not starvation), find_food is preempted and the bot answers the pillager

#### Scenario: Arrow on course
- **WHEN** an arrow is flying at the bot's body before it lands
- **THEN** the bot starts ranged_defense before the hit

#### Scenario: Patrol without armour
- **WHEN** three pillagers have a line to a bot with a sword and a shield but no armour
- **THEN** it takes cover behind a block if one is within 8 blocks, else backs out of range

#### Scenario: Bow and arrows
- **WHEN** one skeleton 12 blocks away shoots at a healthy bot that carries a bow and arrows
- **THEN** it shoots back

#### Scenario: Low health
- **WHEN** a skeleton has a line to the bot at 6 health
- **THEN** the bot goes behind cover and eats there, not in the open

#### Scenario: Bodyguard
- **WHEN** the bot escorts a player above 8 health
- **THEN** stay_safe leaves archers to protect
