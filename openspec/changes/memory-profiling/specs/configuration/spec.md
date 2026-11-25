## ADDED Requirements

### Requirement: Client view distance
The Minecraft Java adapter SHALL ask the server for `settings.world.viewDistance` chunks around the bot: `tiny` (6), `short` (8), `normal` (10), `far` (12) or a whole number from 2 to 32. Unset or invalid values SHALL fall back to `far`, Mineflayer's default. `world.viewDistance` SHALL be a live toggle: changing it in a session sends the new value to the server without a reconnect.

#### Scenario: Default
- **WHEN** a profile does not set `world.viewDistance`
- **THEN** the bot connects asking for 12 chunks, as before

#### Scenario: Smaller view
- **WHEN** a profile sets `settings: { world: { viewDistance: short } }`
- **THEN** the bot asks for 8 chunks and keeps about (2*8+1)^2 chunk columns loaded

#### Scenario: Invalid value
- **WHEN** a profile sets `settings: { world: { viewDistance: 99 } }`
- **THEN** the bot asks for 12 chunks
