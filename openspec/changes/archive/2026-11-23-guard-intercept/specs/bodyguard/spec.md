## ADDED Requirements

### Requirement: Intercept approaching mobs
The bodyguard SHALL engage a hostile moving towards the player while it is between 6 and 12 blocks from the player, before it reaches melee range.

#### Scenario: Zombie walking at the player
- **WHEN** a zombie 10 blocks from the player is moving towards them and nothing else threatens the player
- **THEN** the bot moves to meet it and attacks it before it is within 3 blocks of the player

### Requirement: Creeper safety
The bodyguard SHALL NOT stay within 3 blocks of a creeper with a lit fuse, and SHALL prefer a ranged attack on creepers when it has a bow and arrows.

#### Scenario: Lit fuse
- **WHEN** a creeper next to the bot starts its fuse
- **THEN** the bot moves out of 3 blocks before the fuse ends

#### Scenario: Bow available
- **WHEN** the bot carries a bow and arrows and a creeper approaches the player
- **THEN** it shoots the creeper instead of closing to melee

### Requirement: Gear up when armed
When the bodyguard is armed or the bot respawns while it is armed, the bot SHALL equip the best armour, shield and weapon it has.

#### Scenario: Armed with armour in inventory
- **WHEN** an owner arms the bodyguard and the bot carries iron armour it is not wearing
- **THEN** it wears the armour before escorting
