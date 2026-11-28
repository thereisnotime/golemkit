# start-over Specification

## Purpose
Leave a bad base behind and start again somewhere better: pack the most precious things, walk off by day, dig in at night, and settle at the first place that passes the site rules in `settings.startOver`, with every rule a setting rather than tuned to one bot or world.

## Requirements

### Requirement: Start over trigger
The bot SHALL start a start-over when an owner calls `start_over`, or once on start when `settings.startOver.go` is true and no start-over state is stored. A stored state (even settled or failed) SHALL keep `go` from firing again.

#### Scenario: go fires once
- **WHEN** `startOver.go` is true and storage has no `startOver` key
- **THEN** the start-over begins in the packing phase with the old base at home
- **AND** after it settled and the bot restarts, it does not begin again

### Requirement: Packing the most precious things
Before leaving, the bot SHALL take from its chests near home the most valuable items first (diamonds, ores and ingots, gear better than what it carries, one per slot, arrows, food, seeds, its bed, torches, a stack of logs, some cobblestone) until only `startOver.freeSlots` slots are free; items on `startOver.take` come first and items on `startOver.leave` never.

#### Scenario: junk stays
- **WHEN** the chests hold diamonds, iron, logs, snowballs and dirt
- **THEN** it packs diamonds, iron and a stack of logs and leaves the snowballs and dirt

### Requirement: Leaving the old base
On leaving, the bot SHALL drop home and the state anchored to the old base (base-project anchor and progress, farms, farm and home site records, places, remembered containers, food spots and beds within 256 blocks, ring searches) and keep the old base as the place `old_base`. Base safety and repair SHALL no longer act on the old base.

#### Scenario: fortress forgotten
- **WHEN** the bot leaves the fortress
- **THEN** `projects.spots` and `home` are gone and `places.old_base` holds the old home

### Requirement: Travelling and settling
The bot SHALL walk legs in one heading by day (away from spawn and `startOver.avoid` unless `startOver.direction` is set), taking the `startOver.detours` around blocked legs, dig in at night, and from `startOver.minDistance` look around after each leg; it SHALL settle at the first place with enough grass, logs, open water and animals that is not in a bad biome (`badBiomes`, `badCold`), protected or built on, or at `startOver.maxDistance` at the best fallback place seen, else turn (`maxTurns`), else make do. Settling sets home, places the bed and a chest and stores the `stash` kinds.

#### Scenario: good place found
- **WHEN** the bot is 520 blocks from the old base in a plains biome with grass, trees, water and cows
- **THEN** it sets home there, places its bed and a chest, and the state is settled

#### Scenario: restart mid-way
- **WHEN** the bot restarts while travelling
- **THEN** it carries on with the stored heading and does not set home where it stands

### Requirement: Legs around water
Each start-over leg SHALL take the first of the main heading and its 45 and 90 degree detours whose leg does not end or pass over open water where the world is loaded.

#### Scenario: lake ahead
- **WHEN** the leg north ends in a lake and the leg north-east ends on land
- **THEN** the bot walks the north-east leg

### Requirement: Pinned chests at the old base
Chests listed in settings.storage.chests within 256 blocks of the place `old_base` SHALL not count as its chests (pantry, gear or storage).

#### Scenario: old pantry
- **WHEN** the profile pins a pantry at the old base and the bot has started over
- **THEN** keep_fed, trips and deposits ignore that pantry

### Requirement: Night shelter out of protected ground
When digging in for the night fails because the spot is protected, the start-over SHALL walk on along its heading and try again without counting it as a failed try.

#### Scenario: respawned at spawn at night
- **WHEN** the bot respawns at a protected world spawn at night
- **THEN** it walks 24 blocks along its heading and digs in there

### Requirement: No night walking
When it could not dig in `startOver.shelterTries` times in a night, the start-over SHALL wait for the morning instead of walking on.

#### Scenario: no shelter
- **WHEN** three bunkers failed tonight with the default settings
- **THEN** it waits where it is until day

### Requirement: Best place as the last resort
When the range and the turns are used up, the start-over SHALL settle at the best place it looked at, even a snowy one, and make do where it stands only when it looked nowhere.

#### Scenario: snow everywhere
- **WHEN** every place looked at was snowy and no turns are left
- **THEN** it settles at the highest scoring of them

### Requirement: Another run by id
With startOver.go, a startOver.run id different from the stored run's SHALL start one more start-over once the earlier one is settled or failed, keeping the first old_base.

#### Scenario: run 2
- **WHEN** run 1 settled and the profile sets run 2
- **THEN** a new start-over begins from the current home

### Requirement: Range by distance walked
After a turn, the start-over range SHALL count the blocks actually walked, and a failed walk to a settle target further than `startOver.settleNear` SHALL be retried up to `startOver.settleTries` times before settling where it stands.

#### Scenario: mountains
- **WHEN** legs in the mountains move 20 blocks each
- **THEN** they use up 20 blocks of range each, not a full leg length

### Requirement: Redirect a run
A startOver.run id different from the travelling run's SHALL redirect it to startOver.direction with fresh turns and range, keeping its origin.

#### Scenario: west instead
- **WHEN** run 2 is travelling north and the profile sets run 3 with direction w
- **THEN** on start it carries on west from where it is

### Requirement: Legs avoid ice
Picking a start-over leg SHALL treat ice at the surface like open water.

#### Scenario: frozen ocean ahead
- **WHEN** the leg west ends on a frozen ocean and the leg south-west on land
- **THEN** it walks south-west

### Requirement: Turn at an ocean
When every leg heading within the detours of the current one ends or passes over water or ice, the start-over SHALL turn to the best untried dry heading (while turns are left) instead of swimming, and only when it stands on land.

#### Scenario: ocean west
- **WHEN** heading west and all detours are ocean
- **THEN** it turns to an untried heading instead of swimming

### Requirement: Settings from the toggle schemas
`settings.startOver` SHALL be read through the `startOver.*` toggle schemas, one key at a time: a value that fails its schema SHALL fall back on its default while the other keys still apply, and every settings key SHALL have a toggle.

#### Scenario: one bad key
- **WHEN** the profile sets `startOver: { minDistance: "far", maxDistance: 900 }`
- **THEN** minDistance is the default 500 and maxDistance is 900

### Requirement: Turn after rejected looks
After `startOver.turnAfterRejects` places looked at and rejected in a row, for any reason, the start-over SHALL turn while turns are left (0 turns this off).

#### Scenario: desert ahead
- **WHEN** badBiomes lists desert and three looks in a row are desert
- **THEN** the next legs head another way

### Requirement: Turns pick the best untried heading
Every turn SHALL pick, among the compass headings not tried yet in this run (and not wet when turning at an ocean), the one whose path stays furthest from the avoid points and the old base.

#### Scenario: spawn to the east
- **WHEN** it turns while heading north, spawn lies east and the old base south
- **THEN** it heads west or north-west, not east

### Requirement: Base-anchored state registered by its modules
Storage keys and place names tied to the old base SHALL come from the modules that own them (registered) plus `startOver.dropKeys` and `startOver.dropPlaces`, not from a list in the start-over code.

#### Scenario: a new module
- **WHEN** a module registers the storage key `kiln.state` as base-anchored
- **THEN** leaving the old base drops `kiln.state`

### Requirement: Start-over dimensions
A start-over SHALL only start in a dimension on `startOver.dimensions`, and a run SHALL wait while the bot is in another dimension than its old base.

#### Scenario: in the nether
- **WHEN** an owner says start over while the bot is in the nether
- **THEN** it refuses and says why

### Requirement: home.away cleared without a run
The no-home-on-purpose flag SHALL be cleared whenever no start-over run is active.

#### Scenario: cancelled elsewhere
- **WHEN** the stored run is failed or removed while `home.away` is set
- **THEN** the next check clears it and the NPC controller may set home again
