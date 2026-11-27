## ADDED Requirements

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
