# combat-techniques Specification

## Purpose
How the fight loop, `defend` and the reflexes use skilled-player techniques from the 1.9+ combat system (hit styles, shield timing, totem, golden apples, water bucket, getting air when drowning, enderman gaze, chokepoints), and the opt-in PvP (modes and PvP tactics are in the pvp spec). Each technique has a `combat.*` live toggle.

## Requirements

### Requirement: Hit style per charged hit
Before each fully charged melee hit the bot SHALL choose a sweep when it holds a sword and the mobs within a block of the target take more extra damage than a crit would add, otherwise a sprint (knockback) hit when knockback is wanted or no crit is possible, otherwise a crit. With `combat.sweep` or `combat.sprintReset` off, that style is not used.

#### Scenario: Three zombies bunched around the target
- **WHEN** the bot holds an iron sword without Sweeping Edge and three other zombies stand within a block of its target
- **THEN** it hits on the ground without jumping or sprinting, so the sweep hits all of them

#### Scenario: Creeper
- **WHEN** the bot hits a creeper
- **THEN** the hit is a sprint hit for knockback, not a crit jump

#### Scenario: No room to jump
- **WHEN** the bot fights under a low ceiling where a crit is not possible
- **THEN** it lets go of sprint after each hit and presses it again shortly before the next charge completes (W-tap)

### Requirement: Shield against melee between swings
With `combat.shieldMelee` on and a shield in the offhand, the bot SHALL raise the shield against the melee mob it fights while its next swing is more than 350 ms away, and lower it just before the swing. It SHALL NOT raise it while the shield is disabled (after blocking an axe hit, for the cooldown the server sends).

#### Scenario: Zombie, iron axe in hand
- **WHEN** the bot has just swung an iron axe (1.1 s cooldown) at a zombie 2 blocks away
- **THEN** the shield goes up until shortly before the axe is charged again

#### Scenario: Vindicator
- **WHEN** a vindicator's axe hits the raised shield
- **THEN** the hit does no damage and the bot fights without the shield for the next 5 s

#### Scenario: Totem in the offhand at low health
- **WHEN** a totem is in the offhand and health is 10 or less
- **THEN** the shield is not swapped back in to block

### Requirement: Creeper that can't be outrun
When a creeper's fuse is lit and backing off for the rest of the fuse (gaining about 2 blocks per second walking, 3.5 sprint-jumping with `combat.dodge.creeperLeap`) does not get the bot 7 blocks away, the bot SHALL face it with a raised shield while backing off, if it has a shield and `combat.shieldMelee` is on; otherwise it runs. With `combat.dodge.creeperLeap` on (default off) it SHALL run by sprint-jumping away until the fuse is out or the creeper is 7.2 blocks off (at most `combat.dodge.creeperLeapMs`), steering round unsafe ground, and walk off with the pathfinder only when no direction is safe. A creeper lighting its fuse within 5 blocks while the bot fights another creeper SHALL become the target.

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

### Requirement: Totem in the offhand when it matters
With `combat.totem` on and a totem in the inventory, the bot SHALL move it into the offhand as soon as health drops to 8 or less (10 or less while the bot is on fire, read from its entity flags), or during a fall that would kill it, and keep it there until health is above 14.

#### Scenario: Health drops in a fight
- **WHEN** a hit leaves the bot at 7 health with a shield in the offhand and a totem in the inventory
- **THEN** the totem goes into the offhand right away

#### Scenario: Burning
- **WHEN** the bot is on fire and a burn tick leaves it at 10 health with a shield in the offhand and a totem in the inventory
- **THEN** the totem goes into the offhand right away

#### Scenario: Healing back
- **WHEN** health climbs from 7 to 12 with the totem in the offhand
- **THEN** the totem stays

### Requirement: Golden apple mid-fight
With `combat.goldenApple` on, the bot SHALL eat a golden apple during a fight at 8 health or less, or 12 or less with three or more melee mobs within 4 blocks, unless a creeper with a lit fuse is within 5 blocks or it ate one in the last 8 s.

#### Scenario: Low in a duel
- **WHEN** the bot is at 6 health fighting one zombie and carries a golden apple
- **THEN** it eats the apple while backing off, then fights on

#### Scenario: Lit creeper close
- **WHEN** the bot is at 6 health and a creeper fuses 3 blocks away
- **THEN** it gets away from the creeper first

### Requirement: Water bucket clutch and fire
With `combat.waterClutch` on and a water bucket, the bot SHALL place water just before landing from a fall that would do 3 or more damage (or kill it), and SHALL put out fire with water at its feet when burning on solid ground, scooping the water back up both times. Never in the Nether.

#### Scenario: Knocked off a ledge
- **WHEN** the bot falls 25 blocks onto stone with a water bucket in the inventory
- **THEN** it lands in water it placed and picks the water back up

#### Scenario: Nether
- **WHEN** the same fall happens in the Nether
- **THEN** it does not try the bucket

### Requirement: Air when drowning
With `reflexes.air` on (default), when the bot's eyes are in water or a bubble column and its air is at or below `reflexes.airBelow` (default 10 of 20; 3 earlier at 12 health or less, 6 earlier at 6 or less), the reflexes SHALL stop the current action and start `air`, which takes the cheapest way to a breath, re-planned every tick: straight up when the water above is open; breaking ice or another breakable block within 4 blocks above the head (never in a protected area, never with `canDig` off); swimming to the nearest opening or air pocket within 8 blocks; swimming up when nothing else is found. The check SHALL run on its own timer whatever action holds the body, an open furnace or crafting window included, and `air` SHALL close such a window first. The air SHALL be the bot's own (from its own entity metadata), never another entity's. It SHALL stop at 18 of 20 air, then get out of the water: onto a ledge beside it; out of a pit or shaft whose rim is too high (raise the floor with blocks, dig a step into the wall, pillar from dry feet, until on dry ground); else to dry land within 12 blocks; back up for air first whenever the air drops below 12 on the way. Every re-plan SHALL be logged at debug level with its kind and target. The reflex referee SHALL let `air` take the body from any reflex, and SHALL let nothing but `water_bucket` take it from `air`. `travel`'s low-air stop SHALL use the same planner.

#### Scenario: Under ice
- **WHEN** the bot is 3 blocks under a frozen lake with 10 of 20 air and no hole nearby
- **THEN** it breaks the ice above its head, surfaces through the hole and reports "out of air under ice: broke 1 ice above"

#### Scenario: Opening to the side
- **WHEN** a stone roof covers the water but there is an opening 4 blocks away
- **THEN** it swims to the opening instead of digging through stone

#### Scenario: Protected ice
- **WHEN** the ice above is in a protected area
- **THEN** it does not break it and swims to another opening

#### Scenario: A mob's air
- **WHEN** a zombie near the bot is drowning while the bot breathes
- **THEN** the bot's air stays at 20 and the reflex does not start

#### Scenario: Smelting when the air runs out
- **WHEN** the bot sinks into a flooded shaft with a furnace window open and its air reaches 10
- **THEN** the reflex starts `air`, which closes the window and swims up

#### Scenario: Rim too high
- **WHEN** the bot has its air back in a 1x1 shaft whose rim is 2 blocks above the water
- **THEN** it fills the water under it with a block it carries, digs a step into the wall and climbs out onto the rim

#### Scenario: Eating while drowning
- **WHEN** the eat reflex wants the body while `air` runs
- **THEN** it is held back until the air is back

### Requirement: Dry footing for stations
Smelting, and crafting at a crafting table, SHALL first get the bot out of the water. Smelting SHALL refuse when the bot can't get out or when the only spot that reaches the furnace is in the water. `bunker` SHALL NOT dig a cell with water, ice or lava beside it.

#### Scenario: Asked to smelt while afloat
- **WHEN** the bot floats in a flooded shaft it can't leave and is asked to smelt at a furnace on the rim
- **THEN** it refuses ("I'm in the water ... not smelting here") instead of opening the furnace

### Requirement: Paths keep out of water
The pathfinder movements used by `goto`, `travel`, `go_home` and the reach movements SHALL prefer a dry path: water costs 3 per block instead of 1, more with water above it, more again under a roof within 4 blocks, and much more (30) under ice.

#### Scenario: Frozen lake between the bot and its chest
- **WHEN** the straight path to a chest goes along the bed of an ice-covered lake and a dry path around it exists
- **THEN** the bot walks around (or over the ice) rather than under it

### Requirement: Enderman gaze
With `combat.endermanGaze` on, every look the bot makes SHALL avoid an enderman's eyes (vanilla cone, within 64 blocks), unless that enderman is already fighting the bot or the bot wears a carved pumpkin.

#### Scenario: Pathfinding past an enderman
- **WHEN** the bot walks towards an enderman standing on its path
- **THEN** its pitch is lowered so its gaze passes below the enderman's eyes

#### Scenario: Enderman attacks
- **WHEN** an enderman has hit the bot
- **THEN** the bot looks at it normally to fight it

### Requirement: Chokepoints against crowds
With `combat.chokepoints` on, when three or more melee mobs come at the bot and its health is at least half, `defend` SHALL move to a 1-wide corridor cell within 6 blocks facing the mobs, if there is one, and fight from it without strafing.

#### Scenario: Doorway nearby
- **WHEN** four zombies come across a field and a 1-wide gap in a wall is 4 blocks from the bot
- **THEN** the bot steps into the gap and fights them one at a time

#### Scenario: Open field
- **WHEN** there is no such gap within 6 blocks
- **THEN** it fights as before

### Requirement: PvP is opt-in
Bots SHALL never fight a player while `combat.pvp` is `off` (the default). With `defend` or any mode above it (see the [pvp spec](../pvp/spec.md)) and `reflexes.selfDefense` on, the bot SHALL fight back against a player who hits it, or who hits the player it is guarding, and SHALL stop defending when that player has not hit for 5 s or is more than 10 blocks away. It SHALL never fight an owner, a player in `combat.friends`, or a player in creative or spectator.

#### Scenario: Default
- **WHEN** a player hits the bot and `combat.pvp` is not set
- **THEN** the bot does not fight back

#### Scenario: Defend
- **WHEN** `combat.pvp` is `defend` and a player hits the bot
- **THEN** the bot fights that player with the PvP fight loop (`combat.pvpTactics`, else the mob loop)

#### Scenario: Attacker stops
- **WHEN** the attacker stops hitting for 5 s or runs 10 blocks off
- **THEN** the bot stops fighting

#### Scenario: Owner or friend
- **WHEN** an owner or a player listed in `combat.friends` hits the bot
- **THEN** the bot does not fight back

#### Scenario: Guarded player attacked
- **WHEN** the bodyguard is armed for Alice and a player hits Alice, with `combat.pvp` `defend`
- **THEN** the bot fights that player until they stop or run

### Requirement: No running from faster mobs
With `combat.fightFastMobs` on, the low-health back-off (`reflexes.retreatBelow`) SHALL NOT apply to mobs that outrun the bot (vindicators, ravagers, spiders, cave spiders, wolves, piglin brutes, hoglins, zoglins); the bot keeps fighting them. The water back-off (`reflexes.waterFightAbove`, from a mob standing in water) SHALL still apply to them.

#### Scenario: Vindicator at 7 health
- **WHEN** the bot is at 7 health with `retreatBelow` 8 and a vindicator hits it
- **THEN** it fights the vindicator instead of turning to run

#### Scenario: Fast mob in water
- **WHEN** the bot is at 12 health with `waterFightAbove` 14 and a spider standing in water hits it
- **THEN** it backs off as from any mob in water

### Requirement: Never fight the warden
The bot SHALL NOT attack a warden, and SHALL back off when one hurts it.

#### Scenario: Warden in a deep dark cave
- **WHEN** a warden hits the bot
- **THEN** the bot retreats instead of fighting it

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

### Requirement: Risk-based retreat
With `settings.retreat.enabled` (default on) and `combat.disengageToHeal` on, the fight loop SHALL estimate the damage the hostiles around will do over the next `retreat.hits` (default 2) attack cycles of 1 s: per mob its damage per hit and cooldown from a table (Normal values, scaled for easy and hard, hard cooldowns where they differ), hitting first when it reaches 2 blocks (melee, at its walking speed) or at once with a line of sight within 16 blocks (shooters), reduced by the bot's armour points, toughness and protection (the vanilla formula) and by `retreat.shieldBlocks` (default 0.4) with a shield in the offhand. Creepers SHALL NOT count. It SHALL leave the fight when health is at or below that estimate, or at or below `retreat.floor` (default 4), and once leaving SHALL keep leaving until health is `retreat.hysteresis` (default 4) above the estimate. With `retreat.enabled` off the old rule SHALL apply (back off to eat at 4 health or less when that heals). The reflexes SHALL start `defend` when the rule says leave and a hostile is within 6 blocks. The rule SHALL be pure (incomingDamage, retreatDecision in `src/skills/retreatPlan.ts`).

#### Scenario: Two zombies, no armour
- **WHEN** two zombies are next to an unarmoured bot at 12 health on Normal
- **THEN** it leaves the fight (about 12 damage in 2 s)

#### Scenario: One zombie
- **WHEN** one zombie is next to the same bot at 7 health
- **THEN** it keeps fighting, and leaves at 6

#### Scenario: Iron armour
- **WHEN** two zombies are next to a bot in full iron armour at 8 health
- **THEN** it keeps fighting (about 5.5 damage in 2 s)

#### Scenario: Hysteresis
- **WHEN** the bot left a fight against one zombie and is at 9 health with the zombie still close
- **THEN** it keeps leaving until it is above 10

### Requirement: Escape routes
When it leaves a fight, `defend` SHALL try the escape routes in the order of `retreat.routes` (default home, pillar, sprint, bunker; a route left out is off), skipping those whose pure check refuses: home when there is no home in this dimension, it is further than `retreat.homeRadius` (default 40), the way home runs through the mobs (home within 60 degrees of a mob that is nearer than home) or a mob that outruns the bot is close; pillar without `retreat.pillarHeight` (default 2) filler blocks, placing, room above, in water or a protected area, or with an archer, spider, enderman, slime or flyer close; bunker without digging, in water, a protected area, under a roof or with nothing to seal with; sprint with a mob that outruns the bot. The sprint route SHALL steer the bot directly (forward and sprint away from the melee mobs' centre, turning up to 90 degrees around unsafe steps, jumping when stuck) until the nearest melee mob is `retreat.sprintDistance` (default 24) blocks off, and SHALL count 12 blocks ahead as an escape. With a melee mob within 3 blocks the pillar and bunker routes SHALL sprint off a few blocks first. `ranged_defense` SHALL take the escape routes instead of hiding when the leave rule fires (or a fight ends this way) with a melee mob within 4 blocks, and the reflexes SHALL NOT start another action while an escape runs. After going home it SHALL shut open wooden doors within 4 blocks it is not standing in (`retreat.closeDoors`). On the pillar it SHALL hit what comes into reach without strafing and eat. At most `retreat.maxEscapes` (default 2) escapes SHALL run per defend run; after that, or when no route works, it SHALL back off to eat and fight where it stands.

#### Scenario: Zombies and blocks
- **WHEN** an unarmoured bot with cobblestone and no home nearby leaves a fight with two zombies
- **THEN** it pillars 2 blocks and fights them from the top

#### Scenario: A skeleton among them
- **WHEN** a skeleton with a line of sight is among the mobs
- **THEN** it does not pillar and digs a bunker or sprints away instead

#### Scenario: Vindicator
- **WHEN** a vindicator is the threat
- **THEN** it neither runs home nor sprints, and pillars or bunkers if it can

### Requirement: Recover and come back
After an escape the bot SHALL eat when hungry and carrying food, and wait until health reaches `retreat.returnAbove` (default 16), at most `retreat.healSeconds` (default 60), fighting a mob that comes within reach. With `retreat.comeBack` on and healthy again, `defend` SHALL fight the mobs still around: around home after going home (the fight's anchor moves there), where it left after the other routes.

#### Scenario: Healed at home
- **WHEN** the bot ran home at 6 health, ate to 16, and a zombie stands by its door
- **THEN** it fights the zombie, and does not walk back to where the fight started

### Requirement: No open fight when poorly placed
With `retreat.avoidOpen` on (default), before `defend` takes on its first mob it SHALL count no armour (under `retreat.minArmour` points), night, and `retreat.outnumberedAt` (default 2) or more melee mobs within 8 blocks; with `retreat.avoidFactors` (default 2) of them it SHALL go home (when the home route's check passes) or fight from a 1-wide chokepoint within 6 blocks (`retreat.avoidRoutes`, in order), and fight where it stands only when neither works. It SHALL fight regardless when an owner within 16 blocks has a hostile within 6 of them, or when every close melee mob outruns it.

#### Scenario: No armour at night
- **WHEN** a zombie comes at an unarmoured bot at night 20 blocks from home with nothing in between
- **THEN** it goes home instead of fighting in the field

#### Scenario: Bolder profile
- **WHEN** the same happens with `retreat.avoidFactors: 3`
- **THEN** it fights

#### Scenario: Owner in trouble
- **WHEN** the owner stands 5 blocks off with a zombie on them
- **THEN** it fights

### Requirement: Retreat is reported
Every escape SHALL be logged with why it left, the routes it could use and why the others were skipped, and where it went; the same line SHALL be in the `defend` result and SHALL be the status `event` (`just status`).

#### Scenario: Pillar escape
- **WHEN** the bot pillars away from two zombies at 11 health
- **THEN** the log and status read like "left the fight (health 11 would not survive 2 zombie for 2 s (about 12 damage)), escaped to a 2-block pillar at x y z; healed to 16"

### Requirement: Phantoms
At night, with `combat.phantoms.enabled`, the reflexes SHALL get into a bed within `bedRange` when phantoms are within 32 blocks, no ground hostile is within `groundClear` and the last bed or death is older than `recentMinutes`, and get up again at once. With no phantoms and no bed or death for `insomniaMinutes`, they SHALL get into bed and stay. In bed with a phantom within `engageRange` they SHALL get up. Otherwise a phantom within `engageRange` SHALL start the defend fight without waiting for its hit. A refused bed SHALL not be tried again for `retrySeconds`.

#### Scenario: Phantoms over an unslept bot
- **WHEN** it is night, three phantoms circle, a bed is 4 blocks away and the bot has not slept since it came online
- **THEN** it lies down in the bed, gets up, and fights the phantoms as they come close

#### Scenario: No bed in reach
- **WHEN** a phantom is 12 blocks away and no bed is within 16 blocks
- **THEN** the defend fight starts before the phantom's dive

### Requirement: A mob the fight left is not re-engaged at once
A mob a defend run leaves for a chase refusal (down a drop, in liquid, in a dark cave) SHALL be skipped by the proactive defend reflex for 60 seconds unless it comes within 3 blocks.

#### Scenario: creeper in a hole
- **WHEN** defend left a creeper 6 blocks away because it is down a drop
- **THEN** the proactive reflex does not start defend on it again within the next minute
