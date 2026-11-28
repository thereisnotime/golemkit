## ADDED Requirements

### Requirement: Mixed tag ingredients
Crafting SHALL accept any mix of the members of a tag slot (recognised from recipe variants with the same shape and result), and SHALL first craft a member from held materials (planks from logs) when short. A recipe with a single variant SHALL NOT be mixed.

#### Scenario: chest from two woods
- **WHEN** the bot holds 4 spruce planks and 4 oak planks and crafts a chest
- **THEN** it crafts the chest with the mixed grid

#### Scenario: logs but no planks
- **WHEN** the bot holds logs and too few planks for a chest
- **THEN** it crafts planks from the logs and then the chest
