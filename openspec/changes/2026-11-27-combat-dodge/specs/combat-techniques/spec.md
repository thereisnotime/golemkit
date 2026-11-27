## ADDED Requirements

### Requirement: Dodge layer
The mob fight loop SHALL ask a dodge layer once per tick, before its own movement, what to do: leap (done before the loop goes on), step back, hold ground, or nothing. The per-tick techniques SHALL be a list run in order (draws, arrows, melee timing), the first answer winning, each with its own `combat.dodge.*` switch, and `combat.dodge.enabled` off SHALL turn them all off and leave the movement as before. A leap SHALL face the way to go, sprint and jump, and look back at the target after `combat.dodge.leapMs`. Two leaps SHALL be at least `combat.dodge.minGapMs` apart and a leap SHALL only start on the ground.

#### Scenario: Dodge off
- **WHEN** `combat.dodge.enabled` is off
- **THEN** the bot strafes, steps back after a hit and walks away from a lit creeper as before

#### Scenario: A new technique
- **WHEN** a technique is added to the list
- **THEN** the fight loop needs no change to use it

### Requirement: Safe leaps
Before any leap the bot SHALL check the cells along the leap (`combat.dodge.leapDistance`, sampled every 0.3 blocks) and where it lands: feet and head cells free of walls and water, no lava, fire, powder snow or harmful blocks, and ground no deeper than `combat.dodge.maxDrop` below. A side that fails is not used; with no safe side there is no leap (a melee threat then steps back).

#### Scenario: Water to the left
- **WHEN** an arrow would hit and the cells to the bot's left are water
- **THEN** it leaps right, or not at all when the right is unsafe too

#### Scenario: Cliff
- **WHEN** the ground 2 blocks to the side drops 3 blocks and maxDrop is 2
- **THEN** it does not leap that way

### Requirement: Dodge arrows
With `combat.dodge.arrows` on, the bot SHALL simulate each projectile in flight (its own drag and gravity, moved forward between the server's rare position updates) against its hitbox, inflated by the projectile's half size and `combat.dodge.arrowMargin`, with its own motion included. When one will hit, it SHALL leap perpendicular to the flight to a side that a leap clears in the ticks left after `combat.dodge.latencyMs`, and SHALL not leap for one it can't clear in time. With `combat.dodge.draws` on and an archer within `combat.dodge.drawRange` with a line to it, it SHALL leap a tick (plus latency) before a skeleton's release (20 ticks after it raised its bow), and jink sideways while a pillager holds a charged crossbow (it fires 20 to 39 ticks after charging). The side SHALL be chosen at random between equally good sides, the one with fewer mobs at the landing first, and not the same side three times running. The arrow and draw leaps SHALL also stop a `ranged_defense` walk to cover or out of range when one is due, and `ranged_defense` SHALL decide again after the leap.

#### Scenario: Skeleton at 8 blocks
- **WHEN** a skeleton 8 blocks away has held its bow drawn for 900 ms
- **THEN** the bot leaps to one side before the arrow is released

#### Scenario: Arrow from 20 blocks
- **WHEN** an arrow from 20 blocks away is on course for the bot's chest
- **THEN** the bot leaps sideways and the arrow passes

#### Scenario: Too late
- **WHEN** an arrow will hit next tick
- **THEN** the bot does not leap for it

### Requirement: Melee timing
With `combat.dodge.meleeTiming` on, the bot SHALL note each melee mob's swing (its arm-swing animation, or a melee hit on the bot attributed to the nearest melee mob) and treat it as unable to swing again for its attack cooldown (20 ticks for zombies and most melee mobs, `combat.dodge.meleeCooldownMs` for unknown ones). A mob's reach SHALL be its attack box (its own box grown by sqrt(2.04) - 0.6 sideways, axis-aligned). While every close mob is recharging the bot SHALL hold its ground (no step back after its own hit); when a mob's swing is ready within `combat.dodge.meleeLeadMs` plus latency and the bot is inside its reach plus `combat.dodge.meleeMargin`, it SHALL step back if a walk gets it out in time, else leap out along the axis that leaves the box soonest, and SHALL not sprint into a W-tap meanwhile.

#### Scenario: Zombie just hit the bot
- **WHEN** a zombie hit the bot 100 ms ago and stands 1.6 blocks away
- **THEN** the bot stays and hits it

#### Scenario: Zombie about to swing
- **WHEN** the zombie's last swing was 1.1 s ago and it is 1.2 blocks away
- **THEN** the bot leaps away from it

### Requirement: Dodge counters
Each fight result SHALL carry `dodges` (leaps of every kind) and `arrowsDodged` (arrow or draw leaps not followed by a projectile hit within 1.2 s), and `defend` SHALL report them with the other technique counters. The guard benchmark's `--duel` SHALL take `--dodge on,off` (one run per setting, order flipped every repeat), a `mixed` duel of zombies, skeletons and creepers, and SHALL by default leave the server's time alone (`--time keep`; `--wait-day` waits for the day).

#### Scenario: Bench old against new
- **WHEN** guard-bench runs `--duel zombie,skeleton --dodge on,off`
- **THEN** each duel runs once with the dodge layer and once without, and each result line carries the setting, dodges, arrows dodged and projectile hits

## MODIFIED Requirements

### Requirement: Creeper that can't be outrun
When a creeper's fuse is lit and backing off for the rest of the fuse (gaining about 2 blocks per second walking, 3.5 sprint-jumping with `combat.dodge.creeperLeap`) does not get the bot 7 blocks away, the bot SHALL face it with a raised shield while backing off, if it has a shield and `combat.shieldMelee` is on; otherwise it runs. With `combat.dodge.creeperLeap` on it SHALL run by sprint-jumping away (`combat.dodge.creeperLeapMs`, longer while the fuse still burns within 7.5 blocks), steering round unsafe ground, and walk off with the pathfinder only when no direction is safe. A creeper lighting its fuse within 5 blocks while the bot fights another creeper SHALL become the target.

#### Scenario: Lit fuse at 3 blocks
- **WHEN** a creeper 3 blocks away lights its fuse and the bot has a shield, with creeperLeap off
- **THEN** the bot faces it with the shield up

#### Scenario: Lit fuse at 3 blocks, sprint-jumping
- **WHEN** a creeper 3 blocks away lights its fuse with 1.3 s left and creeperLeap is on
- **THEN** the bot sprint-jumps away instead of blocking

#### Scenario: Lit fuse further out
- **WHEN** a creeper 4.5 blocks away has just lit its fuse
- **THEN** the bot runs

#### Scenario: Second creeper
- **WHEN** the bot fights one creeper and another lights its fuse 4 blocks away
- **THEN** the bot turns to the lit one
