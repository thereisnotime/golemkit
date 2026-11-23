# combat-techniques Specification

## Purpose
How the fight loop, `defend` and the reflexes use skilled-player techniques from the 1.9+ combat system (hit styles, shield timing, totem, golden apples, water bucket, enderman gaze, chokepoints), and the opt-in PvP (modes and PvP tactics are in the pvp spec). Each technique has a `combat.*` live toggle.

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
When a creeper's fuse is lit and backing off for the rest of the fuse (gaining about 2 blocks per second on it) does not get the bot 7 blocks away, the bot SHALL face it with a raised shield while backing off, if it has a shield and `combat.shieldMelee` is on; otherwise it runs. A creeper lighting its fuse within 5 blocks while the bot fights another creeper SHALL become the target.

#### Scenario: Lit fuse at 3 blocks
- **WHEN** a creeper 3 blocks away lights its fuse and the bot has a shield
- **THEN** the bot faces it with the shield up

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
Bots SHALL never fight a player while `combat.pvp` is `off` (the default). With `defend` or any mode above it (see the [pvp spec](../pvp/spec.md)), the bot SHALL fight back against a player who hits it, or who hits the player it is guarding, and SHALL stop defending when that player has not hit for 5 s or is more than 10 blocks away. It SHALL never fight an owner, a player in `combat.friends`, or a player in creative or spectator.

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
