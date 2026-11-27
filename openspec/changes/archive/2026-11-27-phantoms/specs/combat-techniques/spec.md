## ADDED Requirements
### Requirement: Phantoms
At night, with `combat.phantoms.enabled`, the reflexes SHALL get into a bed within `bedRange` when phantoms are within 32 blocks, no ground hostile is within `groundClear` and the last bed or death is older than `recentMinutes`, and get up again at once. With no phantoms and no bed or death for `insomniaMinutes`, they SHALL get into bed and stay. In bed with a phantom within `engageRange` they SHALL get up. Otherwise a phantom within `engageRange` SHALL start the defend fight without waiting for its hit. A refused bed SHALL not be tried again for `retrySeconds`.

#### Scenario: Phantoms over an unslept bot
- **WHEN** it is night, three phantoms circle, a bed is 4 blocks away and the bot has not slept since it came online
- **THEN** it lies down in the bed, gets up, and fights the phantoms as they come close

#### Scenario: No bed in reach
- **WHEN** a phantom is 12 blocks away and no bed is within 16 blocks
- **THEN** the defend fight starts before the phantom's dive
