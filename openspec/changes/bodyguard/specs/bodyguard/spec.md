## ADDED Requirements

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
When the player's health is visible and low, the bodyguard SHALL toss them its best food, keeping its own reserve, and say so; when the server sends neither health nor hunger for the player it SHALL not feed.

#### Scenario: Hurt player
- **WHEN** the player is at 6 health within 5 blocks, nothing threatens them and the bot carries 7 food items with a reserve of 4
- **THEN** it tosses them two of its best food

#### Scenario: Reserve
- **WHEN** the bot carries no more food than its reserve
- **THEN** it doesn't feed

### Requirement: Night and offline
While the bodyguard is armed and the player is online, the bot SHALL stay with them at night instead of going home or digging in, but SHALL still pillar up, retreat or back off to heal when it is about to die; when the player goes offline it SHALL wait where they were last seen or go home, as configured.

#### Scenario: Night
- **WHEN** night falls far from home while escorting
- **THEN** stay_safe does not go home

#### Scenario: Player logs off
- **WHEN** the player goes offline with `whenGone: home`
- **THEN** the bot goes home
