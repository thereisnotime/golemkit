## ADDED Requirements

### Requirement: Routine by time of day
The bot SHALL arm the behaviours of the routine window that matches the time of day and disarm those of the previous window.

#### Scenario: Morning
- **WHEN** the time passes 0 (morning) with the default routine
- **THEN** farming and depositing are armed

#### Scenario: Night
- **WHEN** it gets dark
- **THEN** the bot goes to bed if it has one, otherwise follows stay_safe

### Requirement: NPC mode default
When the LLM pauses for quota and no `npcMode.arm` is set, NPC mode SHALL use the daily routine.

#### Scenario: Quota pause
- **WHEN** the provider reports a weekly limit
- **THEN** the daily routine starts
