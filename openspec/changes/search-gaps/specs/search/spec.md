## ADDED Requirements

### Requirement: Hunting source
bring_item SHALL hunt the matching animal when the item is a mob drop and no inventory, chest or crafting source has it.

#### Scenario: Leather
- **WHEN** an owner asks for 3 leather and none is stored
- **THEN** the bot hunts cows and brings the leather

### Requirement: Resume after preemption
bring_item SHALL continue from its last completed step after a reflex preempts it.

#### Scenario: Fight mid-task
- **WHEN** the bot is attacked after crafting planks but before delivering them
- **THEN** after the fight it delivers without crafting again
