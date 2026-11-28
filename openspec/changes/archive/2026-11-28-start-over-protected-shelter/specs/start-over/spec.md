## ADDED Requirements

### Requirement: Night shelter out of protected ground
When digging in for the night fails because the spot is protected, the start-over SHALL walk on along its heading and try again without counting it as a failed try.

#### Scenario: respawned at spawn at night
- **WHEN** the bot respawns at a protected world spawn at night
- **THEN** it walks 24 blocks along its heading and digs in there
