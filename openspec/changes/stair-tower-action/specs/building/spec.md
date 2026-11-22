## ADDED Requirements

### Requirement: Stair tower
build_stair_tower SHALL build a walkable spiral staircase between the given heights with the requested size, lights and windows.

#### Scenario: Default tower
- **WHEN** a bot builds a size 4 tower from y 93 to 119
- **THEN** every step is one block higher than the previous and both openings are reachable
