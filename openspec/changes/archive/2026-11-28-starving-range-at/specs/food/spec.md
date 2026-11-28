## MODIFIED Requirements

### Requirement: Starving takes the closest sure food
With food at or below `starvingRangeAt` (keep_fed default 8), keep_fed SHALL skip its farm, remembered food spots and known food places further than `starvingRange` (default 96 blocks) and use near sources (chests, crops in range, hunting in range, fishing near home) instead.

#### Scenario: a village 3500 blocks away
- **WHEN** food is 5, the inner rings came up empty and the only known place is a village 3500 blocks away
- **THEN** keep_fed does not start a trip there

#### Scenario: one above critical
- **WHEN** food is 7 and the only known place is 3500 blocks away
- **THEN** keep_fed does not start a trip there (it would turn back at the trip food floor of 6)
