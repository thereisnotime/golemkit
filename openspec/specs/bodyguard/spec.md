# bodyguard Specification

## Purpose
The bodyguard behaviour and its protect / feed_player actions: keep a player safe from mobs without the LLM.

## Requirements

### Requirement: Threats ranked from the player
The bodyguard SHALL pick targets by their threat to the protected player, measured from the player's position, and SHALL always put a creeper within 6 blocks of the player first.

#### Scenario: Creeper near the player
- **WHEN** a creeper is 5.5 blocks from the player while a zombie that just hit the player stands next to them
- **THEN** the creeper is the first target

#### Scenario: Mob near the bot only
- **WHEN** one zombie is 3 blocks from the player and another 3 blocks from the bot but 14 from the player
- **THEN** the zombie by the player ranks first and the other still counts as a threat to the bot

#### Scenario: Archer without a shot
- **WHEN** a skeleton 14 blocks from the player has no line of sight to them
- **THEN** it is not a threat yet

#### Scenario: Diving phantom
- **WHEN** a phantom 18 blocks from the player comes down towards them
- **THEN** it is a threat, while a circling phantom at the same distance is not

### Requirement: Melee on the player before archers
A melee mob within 3 blocks of the player that just hurt them SHALL rank above archers, and below a creeper within 6 blocks of the player.

#### Scenario: Zombie hitting the player, skeleton shooting
- **WHEN** a zombie 2 blocks from the player just hit them and a skeleton 8 blocks away with a shot has also hit them
- **THEN** the zombie is the first target and the skeleton the second

#### Scenario: Melee not on the player
- **WHEN** the zombie that hit the player is 5 blocks from them
- **THEN** the archer with a shot ranks first

### Requirement: Intercept approaching mobs
The bodyguard SHALL treat a ground mob moving towards the player between 6 and 12 blocks from them as a threat to intercept, meet it on its predicted path (velocity from position samples) rather than at the player, and among similar mobs SHALL go first for the one that reaches the player soonest.

#### Scenario: Zombie walking at the player
- **WHEN** a zombie 10 blocks from the player is moving towards them and nothing else threatens the player
- **THEN** its reason is "intercept" and the bot walks to a point on the zombie's path between it and the player before fighting it

#### Scenario: Two zombies the same distance out
- **WHEN** two zombies 9 blocks from the player close in, one reaching them in 1.5 s and the other in 4 s
- **THEN** the faster one ranks first

### Requirement: Pull aggro off the player
With two or more ground melee mobs within 4 blocks of the player that are hitting or closing on them, the bodyguard SHALL hit each one it has not hit in the last 6 seconds once, so it turns on the bot, and then step to a spot 6 blocks from the player on its own side so the mobs follow it; a single mob on the player SHALL simply be fought.

#### Scenario: Two zombies on the player
- **WHEN** two zombies stand 1.4 and 2.2 blocks from the player and have hit them
- **THEN** the bot hits the nearer one once, then the other, then steps 6 blocks off the player

#### Scenario: One zombie
- **WHEN** only one zombie is on the player
- **THEN** there is no pull; the bot fights it

### Requirement: Intercept and pull aggro can be turned off
The bodyguard behaviour and the protect action SHALL take `intercept` and `pullAggro` options (both default on). With `intercept: false` the bot SHALL not walk to a mob's predicted path and SHALL rank threats without the time-to-player bonus; with `pullAggro: false` it SHALL not tag mobs and step off the player. The guard benchmark (`scripts/guard-bench.ts`) SHALL arm the bodyguard with them off for `--no-intercept` and `--no-pull` (`--variants all,no-intercept,no-pull,neither` runs one guard phase per variant) and record the variant with each result.

#### Scenario: Intercept off
- **WHEN** the bodyguard is armed with intercept false and a zombie 10 blocks from the player walks at them
- **THEN** the bot fights the zombie without first walking to a point on its path

#### Scenario: Benchmark variant
- **WHEN** guard-bench runs with --no-pull
- **THEN** the bodyguard is armed with pullAggro false and each result has variant "no-pull"

### Requirement: Creeper safety
The bot SHALL back away from a creeper whose fuse is lit within 5 blocks (never staying within 3 of a lit fuse), SHALL shoot a creeper from 5 or more blocks when it has a bow or crossbow and arrows and the player is not in the line of fire, and otherwise SHALL hit it once and step back.

#### Scenario: Lit fuse
- **WHEN** a creeper 2.5 blocks from the bot starts its fuse
- **THEN** the bot backs away to 7 blocks before the fuse ends

#### Scenario: Bow available
- **WHEN** the bot carries a bow and arrows and a creeper 8 blocks away approaches the player
- **THEN** it shoots the creeper instead of closing to melee

#### Scenario: Player in the line
- **WHEN** the same creeper has the player behind it on the bot's line
- **THEN** it closes in and uses the sword

### Requirement: Gear up when armed
When protect starts (the bodyguard is armed) and every few seconds while it runs quietly, the bot SHALL put on the best armour, shield or totem it carries, so gear handed to it after a respawn is worn before the next fight; the reflexes SHALL also check for gear right after a respawn.

#### Scenario: Armed with armour in inventory
- **WHEN** an owner arms the bodyguard and the bot carries iron armour it is not wearing
- **THEN** it wears the armour before escorting

### Requirement: Retarget mid-fight
While fighting one mob, the bodyguard SHALL re-rank the threats at least once a second and drop the current target when it is no longer a threat or when another threat scores clearly higher (60 points), so it does not flip between similar mobs.

#### Scenario: Zombie reaches the player during an archer chase
- **WHEN** the bot is chasing a skeleton and a zombie starts hitting the player
- **THEN** the bot stops the chase and fights the zombie

#### Scenario: Two similar zombies
- **WHEN** two zombies approach the player 4 and 6 blocks away and the bot fights the farther one
- **THEN** it keeps its target

### Requirement: Crowds while escorting
While escorting, the bot SHALL NOT treat a crowd of hostiles around it as surrounded (pillar or back off) above 12 health; at 12 or less the usual surrounded rule applies.

#### Scenario: Wave reaches the player
- **WHEN** three zombies come within 6 blocks of the bot at full health while it escorts its player
- **THEN** stay_safe leaves it fighting by the player

#### Scenario: Hurt in a crowd
- **WHEN** the same happens at 12 health
- **THEN** stay_safe pillars up or backs off

### Requirement: No friendly fire
The bodyguard SHALL NOT shoot (bow or crossbow) while the protected player is within 1.5 blocks of the line from the bot to its target, from the bot up to 4 blocks past the target; it SHALL close in instead.

#### Scenario: Player between bot and archer
- **WHEN** the bot holds a bow and the player stands between it and a skeleton
- **THEN** it does not shoot

#### Scenario: Player behind the target
- **WHEN** the player stands 2 blocks behind the skeleton on the same line
- **THEN** it does not shoot, since a miss would hit them

### Requirement: Never-attack rules
The bodyguard SHALL NOT attack players, pets, villagers, golems or named mobs, and SHALL attack neutral mobs only while they attack the player or the bot.

#### Scenario: Enderman near the player
- **WHEN** an enderman stands next to the player without attacking
- **THEN** it is left alone

#### Scenario: Wolf attacking
- **WHEN** a wild wolf attacks the player
- **THEN** it may be fought, but a tamed wolf never is

### Requirement: Positioning
With a hostile mob around and nothing to fight yet, the bot SHALL stand between the player and that mob at the follow distance, at most halfway to it; against an archer it cannot reach, it SHALL stand where it blocks the archer's line of fire, behind a shield when it has one.

#### Scenario: Between player and threat
- **WHEN** a mob is 10 blocks east of the player and the follow distance is 3
- **THEN** the guard spot is 3 blocks east of the player

#### Scenario: Archer on a ridge
- **WHEN** a skeleton stands 8 blocks above the player 10 blocks away
- **THEN** the blocking spot moves closer than 1.5 blocks so the steep line still crosses the bot's body

#### Scenario: Archer straight above
- **WHEN** no spot can cover the line of fire
- **THEN** the bot closes in instead of blocking

### Requirement: Warnings
The bodyguard SHALL warn the player in chat about threats, with directions relative to the player (melee mobs and creepers by where the player looks, archers by compass), rate limited by a gap between any two warnings and a longer gap before the same warning again.

#### Scenario: Creeper behind
- **WHEN** a creeper is behind the player
- **THEN** the warning reads "creeper behind you"

#### Scenario: Rate limit
- **WHEN** two warnings come within 5 seconds, or the same warning within 30 seconds
- **THEN** the later one is not sent

### Requirement: Feeding
When the player's health (10 or less) or hunger (6 or less) is visible and low, nothing threatens them, they are within 5 blocks and it has not fed them in the last 30 s, the bodyguard SHALL toss them up to two of its best food, keeping its own reserve, and say so; when the server sends neither health nor hunger for the player it SHALL not feed.

#### Scenario: Hurt player
- **WHEN** the player is at 6 health within 5 blocks, nothing threatens them and the bot carries 7 food items with a reserve of 4
- **THEN** it tosses them two of its best food

#### Scenario: Reserve
- **WHEN** the bot carries no more food than its reserve
- **THEN** it doesn't feed

### Requirement: Night and offline
While the bodyguard is armed and the player is online, the bot SHALL stay with them at night instead of going home or digging in, but SHALL still pillar up, retreat or back off to heal when it is about to die; when the player goes offline it SHALL wait where they were last seen or go home, as configured (`whenGone: stay | home`, default stay).

#### Scenario: Night
- **WHEN** night falls far from home while escorting
- **THEN** stay_safe does not go home

#### Scenario: Player logs off
- **WHEN** the player goes offline with `whenGone: home`
- **THEN** the bot goes home
