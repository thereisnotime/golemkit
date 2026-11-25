## ADDED Requirements

### Requirement: Needs from the adapter
The NPC controller SHALL accept a needs provider from the game adapter. Each need SHALL have a name, an urgency from 0 to 1 computed from the game state, and the names of the behaviours that serve it. The Minecraft adapter SHALL provide `safety`, `food`, `gear`, `supplies` and `rest`. Game-agnostic code SHALL NOT read the game client directly; urgencies, what counts as food or gear and which items supply the base come from the adapter.

#### Scenario: Gear urgency
- **WHEN** Pax has stone tools, keep_tools_upgraded is armed with upTo iron and armour on, and it wears no armour
- **THEN** the gear need has an urgency of at least 0.5 and names keep_tools_upgraded as serving it

### Requirement: Active needs
A need SHALL be active when `needs.enabled` is on and either the need is enabled explicitly in `needs.<name>` or at least one behaviour serving it is in the controller's set; `needs.<name>.enabled: false` SHALL switch it off.

#### Scenario: No tool behaviour
- **WHEN** a bot has no keep_tools_upgraded and the profile does not mention `needs.gear`
- **THEN** the gear need never boosts anything and never starts a search

### Requirement: Boosting serving behaviours
While an active need's urgency is at or above its `threshold` (default 0.5), every behaviour serving it that scores above 0 SHALL score `boost * urgency` more (default boost 15), never pushed to `urgentScore` or above by the boost.

#### Scenario: Hungry with a farm to tend
- **WHEN** the food need is at 0.6 and farm_setup scores 28
- **THEN** farm_setup scores 37

### Requirement: Go looking
When no regular behaviour scores above the idle band (15), an active need at or above its threshold whose serving behaviours all score 0, with a search from the adapter and `search` on, SHALL start one bounded search: by day only (unless `needs.search.atNight`), within `radius` blocks and `minutes` minutes (per need, else `needs.search`), at most once every `cooldownMinutes` per need and `perDay` times a day per need. The Minecraft gear search SHALL look for iron ore with an open face (find_target, remembering `found:iron`), run upgrade_tools at the find under the safe-mining rules, and walk home, inside a trip budget. The outcome SHALL be remembered in storage.

#### Scenario: No ore in sight
- **WHEN** Pax has stone tools, no iron, no ore within 24 blocks, nothing else to do, and it is day
- **THEN** it starts `need:gear`, walks a spiral out to 160 blocks looking for exposed iron ore, mines it if it is within the safe depth, and comes home

#### Scenario: Searched recently
- **WHEN** the gear search ran 10 minutes ago and found nothing
- **THEN** the gear need does not search again until 30 minutes have passed

### Requirement: Controller snapshot
The controller SHALL expose `snapshot()` returning a plain object with the running behaviour and since when, its goal, the most urgent active need and its urgency, why the behaviour was chosen, the idle mode and chore, and the time of the last progress (the last successful run or action).

#### Scenario: Status view
- **WHEN** the status view calls snapshot() while the gear search runs
- **THEN** it gets behavior `need:gear`, need `gear`, a reason naming the search and a lastProgressAt timestamp
