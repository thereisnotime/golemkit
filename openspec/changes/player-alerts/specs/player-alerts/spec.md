## ADDED Requirements

### Requirement: Unknown player nearby
The bot SHALL whisper its owners when a player who is neither an owner nor a friend comes within the alert radius, at most once per player per cooldown.

#### Scenario: Stranger
- **WHEN** a player not in owners or friends walks within 32 blocks of the base
- **THEN** online owners get one whisper with the name and position
