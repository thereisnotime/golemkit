## ADDED Requirements

### Requirement: NeoForge channel negotiation
The bot SHALL pass NeoForge 21.1 channel negotiation by offering the channels the server requires, learned from previous negotiation failures.

#### Scenario: First connection with no cache
- **WHEN** the bot connects with no cached channels
- **THEN** it records each channel reported missing, and the flow and version reported in later failures
- **AND** reconnects until the server accepts the channel list

#### Scenario: Cached channels
- **WHEN** a channel cache exists for the host and port
- **THEN** the first connection attempt is accepted without relearning

### Requirement: NeoForge configuration tasks
The bot SHALL answer NeoForge configuration tasks so the configuration phase completes.

#### Scenario: Registry and check payloads
- **WHEN** the server sends frozen registry sync completion, known data maps, extensible enum data or feature flag data
- **THEN** the bot replies with the matching acknowledgement payload

### Requirement: Unparseable packets do not drop the connection
The bot SHALL skip clientbound packets it cannot parse and stay connected.

#### Scenario: Recipe list with modded items
- **WHEN** a packet fails to parse because of modded data
- **THEN** the packet is dropped, logged once per packet id, and later packets are still processed

### Requirement: Modded blocks are solid
Block states unknown to the vanilla data SHALL be treated as solid full cubes.

#### Scenario: Standing on a modded block
- **WHEN** the bot stands on a Create casing
- **THEN** physics and pathfinding treat it as solid ground
