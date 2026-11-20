## ADDED Requirements

### Requirement: Chat commands
The bot SHALL respond to prefixed chat commands and unprefixed whispers from allowed players.

#### Scenario: Help
- **WHEN** a player says `!help`
- **THEN** the bot lists its commands in at most two chat lines

#### Scenario: Owner restriction
- **WHEN** `MC_OWNERS` is set and a player not in the list sends a command
- **THEN** the bot ignores it

### Requirement: Movement commands
The bot SHALL support come, follow, goto and stop using the pathfinder, without breaking blocks unless `MC_CAN_DIG` is enabled.

#### Scenario: Follow
- **WHEN** a visible player says `!follow`
- **THEN** the bot keeps within two blocks of them until told to stop

### Requirement: Combat
The bot SHALL fight back when hurt by a hostile mob and, in guard mode, attack hostile mobs within 12 blocks of the guarded player.

#### Scenario: Guard mode
- **WHEN** guard mode is on and a zombie approaches the guarded player
- **THEN** the bot equips its best weapon and attacks the zombie

### Requirement: Survival upkeep
The bot SHALL eat when its food level drops below 15, respawn after death and reconnect after being disconnected.

#### Scenario: Disconnect
- **WHEN** the connection drops
- **THEN** the bot reconnects after `MC_RECONNECT_DELAY_MS`

### Requirement: Chat rate limit
The bot SHALL send at most one chat line per 1.1 seconds.

#### Scenario: Many replies
- **WHEN** several replies are queued at once
- **THEN** they are sent spaced out and the server does not kick the bot for spam
