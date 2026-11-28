## ADDED Requirements

### Requirement: Pinned chests at the old base
Chests listed in settings.storage.chests within 256 blocks of the place `old_base` SHALL not count as its chests (pantry, gear or storage).

#### Scenario: old pantry
- **WHEN** the profile pins a pantry at the old base and the bot has started over
- **THEN** keep_fed, trips and deposits ignore that pantry
