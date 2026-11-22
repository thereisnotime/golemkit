## ADDED Requirements

### Requirement: Known misses handled
The intent pipeline SHALL classify the listed missed phrasings correctly without new false triggers on the must-not-trigger set.

#### Scenario: Creepers
- **WHEN** an owner says "keep the creepers away from me"
- **THEN** the intent is guard

#### Scenario: Inventory
- **WHEN** an owner says "show me what you are carrying"
- **THEN** the intent is inventory
