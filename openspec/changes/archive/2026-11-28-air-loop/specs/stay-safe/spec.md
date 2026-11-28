## ADDED Requirements

### Requirement: Air loop escape
When the air action runs `reflexes.airLoopRuns` times within `airLoopMinutes` and `airLoopRadius` blocks, the bot SHALL dig out to open sky after getting air instead of staying in the water.

#### Scenario: flooded pocket under a roof
- **WHEN** the bot needed air three times in the same pocket within three minutes
- **THEN** after the next breath it climbs out to the sky
