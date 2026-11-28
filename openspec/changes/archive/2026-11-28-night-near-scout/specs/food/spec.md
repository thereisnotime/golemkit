## ADDED Requirements

### Requirement: The night scout the ladder picks actually runs
When keep_fed picks a scout at night (a starving bot, a ring no wider than `riskyRingsFrom`), it SHALL run find_food with night scouting allowed for that run.

#### Scenario: starving at night
- **WHEN** food is 5, it is night and the ladder picks the 48-block ring
- **THEN** find_food scouts instead of refusing with "it is night"
