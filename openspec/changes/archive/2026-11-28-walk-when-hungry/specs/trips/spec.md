## ADDED Requirements

### Requirement: Walk when hungry
The pathfinder SHALL sprint only while the food bar is above `pathfinder.sprintAbove` (default 12; 0 = always sprint), re-checked whenever health or food changes.

#### Scenario: food trip on a low bar
- **WHEN** food is 10 and a behaviour walks to a food spot
- **THEN** the walk does not sprint
