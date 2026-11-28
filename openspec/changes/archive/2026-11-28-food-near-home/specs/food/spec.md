## ADDED Requirements

### Requirement: Starving takes the closest sure food
With food at or below the critical level (6), keep_fed SHALL skip its farm, remembered food spots and known food places further than `starvingRange` (default 96 blocks) and use near sources (chests, crops in range, hunting in range, fishing near home) instead.

#### Scenario: a village 3500 blocks away
- **WHEN** food is 5, the inner rings came up empty and the only known place is a village 3500 blocks away
- **THEN** keep_fed does not start a trip there

### Requirement: Rotten flesh as a last resort
With food at or below `eatRottenAt` (default 6; 0 turns it off) and no better food carried, keep_fed SHALL eat rotten flesh it carries.

#### Scenario: starving with rotten flesh
- **WHEN** food is 5, nothing else edible is carried and it has 18 rotten flesh
- **THEN** it eats rotten flesh before looking further

### Requirement: Fishing near home
keep_fed SHALL fish when it has a fishing rod or can get one (from its chests, or crafted from 2 string and 3 sticks it carries or takes from its chests) and there is open water or lake ice within `fishRange` (default 48) of home; after hunting, before trips and searches; by day, or at night when starving; never with hostiles near.

#### Scenario: string in the chest, water by the base
- **WHEN** it is hungry, has no animals in range, its chest holds 3 string and open water is 25 blocks from home
- **THEN** it takes the string, crafts a rod and fishes

### Requirement: Bread from wheat in its chests
When the wheat it carries and the wheat in containers it may take from add up to 3 or more, keep_fed SHALL take the wheat and bake bread.

#### Scenario: one wheat in each of two chests and one carried
- **WHEN** it carries 1 wheat and its chests hold 1 each
- **THEN** it takes both and bakes a bread
