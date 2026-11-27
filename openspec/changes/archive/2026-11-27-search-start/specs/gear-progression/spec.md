## ADDED Requirements
### Requirement: Search start threshold
A need search SHALL be allowed to start while no other behaviour scores above `needs.search.startBelow` (default 30) and every behaviour serving the need scores 0. When other behaviours score above the idle band but not above `startBelow`, the search SHALL score `startBelow + 1` and start once the running behaviour ends, without cutting into it.

#### Scenario: Upkeep does not starve the gear search
- **WHEN** the gear need is urgent, keep_tools_upgraded scores 0 and chop_wood_loop scores 30
- **THEN** the gear search starts after the current wood run ends
