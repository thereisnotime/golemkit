## ADDED Requirements

### Requirement: Attack timing
The bot SHALL swing on the held weapon's attack cooldown (1 / attack speed) and restart the cooldown when it switches items.

#### Scenario: Sword and axe
- **WHEN** the bot fights with a stone sword, then with a stone axe
- **THEN** it waits 625 ms between sword swings and 1250 ms between axe swings

### Requirement: Critical hits
With `combat.crits` on, the bot SHALL jump so that it is falling when the weapon is charged and swing then, not while sprinting, in liquid or under a low ceiling; the first hit of a fight SHALL be a sprint hit.

#### Scenario: Crit
- **WHEN** a zombie is in reach and the cooldown has 250 ms left
- **THEN** the bot jumps and swings once it is falling with a full charge

#### Scenario: Under a ceiling
- **WHEN** the block two above the bot's feet is solid
- **THEN** the bot swings from the ground without jumping

### Requirement: Spacing and safe movement
With `combat.strafe` on, the bot SHALL keep 2.2 to 2.9 blocks from melee mobs, strafe between swings and step back after a hit, and SHALL NOT step into liquid, fire or off a drop of more than 2 blocks.

#### Scenario: Cliff edge
- **WHEN** the strafe direction leads off a 5-block drop
- **THEN** the bot strafes the other way

### Requirement: Chase limits
The bot SHALL stop chasing a mob more than `combat.maxChase` blocks from where the fight started, into water or lava, down a drop of more than 4 blocks, into a dark cave (unless already in one), or when it has not got closer for 3 s.

#### Scenario: Skeleton on a ledge
- **WHEN** the bot can't get closer to a skeleton for 3 s and has no bow
- **THEN** the fight ends and `defend` backs out of the skeleton's line of fire

### Requirement: Target choice
`defend` SHALL fight a lit or close creeper first, then an archer with line of sight, then the nearest melee mob, and SHALL NOT attack players, villagers, golems, pets or named mobs; neutral mobs only while they attack the bot.

#### Scenario: Creeper and zombie
- **WHEN** a creeper is 5 blocks away and a zombie 2 blocks away
- **THEN** the bot fights the creeper first

#### Scenario: Enderman
- **WHEN** an enderman walks past without attacking
- **THEN** the bot neither attacks nor looks at it

### Requirement: Disengage
The bot SHALL escape when 3 or more melee mobs are within 6 blocks and health is under half: a 2-block pillar if it has blocks, else home if within 48 blocks, else back off. With `combat.disengageToHeal` on and health at 4 or less, it SHALL back off, eat (or let natural regeneration work when the hunger bar is 18 or more), and fight on, regardless of `reflexes.retreatBelow`.

#### Scenario: Stand ground but not die
- **WHEN** Pax (`retreatBelow: 0`) is at 3 health with bread and a zombie close
- **THEN** it backs off about 10 blocks, eats, and goes back to fighting

### Requirement: Armour and offhand
With `combat.autoArmor` on, the bot SHALL wear the best armour in its inventory and keep a totem (health <= 10 or no shield) or a shield in the offhand, whenever that changes.

#### Scenario: Crafted armour
- **WHEN** the bot crafts an iron chestplate
- **THEN** within a few seconds it wears it

### Requirement: Ballistic aim
The bot SHALL aim arrows with gravity and drag and lead moving targets by their measured velocity.

#### Scenario: Far target
- **WHEN** a target stands 35 blocks away on level ground
- **THEN** the computed arc lands within 5 cm of it

### Requirement: Night readiness
`stay_safe` SHALL head home at night with higher priority when the bot has no armour, weapon or food, and without a home SHALL dig in with `bunker` when unprepared and not under a roof.

#### Scenario: Unprepared without a home
- **WHEN** night falls and the bot has no armour and no home
- **THEN** it bunkers until morning

### Requirement: Engage early
Reflexes SHALL start `defend` when a creeper comes within 7 blocks or any hostile within 4 blocks, before it lands a hit, and on any health drop with a threat around.

#### Scenario: Creeper walks up
- **WHEN** the bot is idle and a creeper walks to 6 blocks
- **THEN** it fights the creeper before the fuse is lit
