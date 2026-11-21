## ADDED Requirements

### Requirement: Stand spots that can be reached
Placement SHALL only stand on cells with a full block below and two passable blocks, never inside another structure in the footprint, SHALL prefer spots near the bot at or above the target level, and SHALL not try a spot that failed again in the same build.

#### Scenario: Floor under an existing hut
- **WHEN** a floor cell lies under the wall of a hut that isn't part of the blueprint
- **THEN** the bot stands outside the hut at floor level, not inside it and not in a pocket under the floor

#### Scenario: Unreachable spot
- **WHEN** walking to a stand spot doesn't get there within its 4 to 8 s budget
- **THEN** the spot is remembered and the next block doesn't try it

### Requirement: Batching placements
Within a layer the build SHALL place the nearest block that has something to click and is in reach from where the bot stands before walking anywhere.

#### Scenario: Floor
- **WHEN** part of a floor is laid
- **THEN** the next floor block is one next to it within reach, not one across the site

### Requirement: Be at the site
The build SHALL travel to the footprint first and fail with where it stopped when it ends more than 12 blocks away.

### Requirement: Creative flight never hangs
Creative flight SHALL go up, across and down without entering blocks, honour the action signal and give up after a time limit; creative stocking SHALL give up on a slot the server doesn't confirm.
