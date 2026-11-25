## ADDED Requirements

### Requirement: Checking sites when used
The needs layer SHALL check every site the adapter lists (Minecraft: farms, the spawn bed, its own chests, home) when the check can tell (the site is loaded), at most once every `sites.checkMinutes` (default 5) per site. A check SHALL say ok, can't tell, or bad with a fault: flooded, gone, unsafe, unreachable or no work. Behaviour failures the adapter maps to a site (a farm it couldn't get to) SHALL count as checks.

#### Scenario: Farm under ice
- **WHEN** Pax is near farm:1 and 60 of its 80 cells are ice or water
- **THEN** the check says flooded

### Requirement: Marking sites bad
A flooded, gone or unsafe check SHALL mark the site bad at once; unreachable or no work SHALL mark it bad after `sites.failures` (default 3) such checks in a row; an ok check SHALL clear the count. A bad site SHALL be persisted in `agent.storage` with its kind, id, position, reason and time, recorded as a `site` journal event, and, with `sites.tell` on, whispered to the owners online.

#### Scenario: Unreachable three times
- **WHEN** farm_setup fails "couldn't get to farm:1" three times in a row
- **THEN** farm:1 is marked bad with reason unreachable

### Requirement: Replacing bad sites
With `sites.replace` on, the adapter SHALL replace a bad site when it can. A bad Minecraft farm SHALL be removed from the bot's farm list so its food behaviours start a new one near home; start_farm SHALL skip candidates within the bad site's plot plus 8 blocks, water in a biome cold enough to freeze, cells under a roof or without sky light, and sites with lava close by, and SHALL keep the protected-area and spawn-clearance rules. Sites it can't replace (configured chests, home) SHALL be left to the owners, who are told.

#### Scenario: New farm on dry ground
- **WHEN** farm:1 at 561 62 -20 was marked flooded and Pax has seeds in its pantry
- **THEN** keep_fed takes seeds from the pantry and starts farm:2 near home, not within 13 blocks of 561 -20

### Requirement: Re-checking bad sites
A bad site SHALL be checked again when the bot is near it and `sites.recheckHours` (default 6) have passed since it was marked or last re-checked. An ok re-check SHALL mark it ok again and say so; a bad one SHALL keep it bad and restart the wait.

#### Scenario: A player drained the lake
- **WHEN** farm:1 was flooded 7 hours ago and its cells are dirt and farmland again
- **THEN** the record goes back to ok and the owners hear that the farm is usable again
