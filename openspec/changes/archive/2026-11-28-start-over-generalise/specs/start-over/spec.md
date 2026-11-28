## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Travelling and settling
The bot SHALL walk legs in one heading by day (away from spawn and `startOver.avoid` unless `startOver.direction` is set), taking the `startOver.detours` around blocked legs, dig in at night, and from `startOver.minDistance` look around after each leg; it SHALL settle at the first place with enough grass, logs, open water and animals that is not in a bad biome (`badBiomes`, `badCold`), protected or built on, or at `startOver.maxDistance` at the best fallback place seen, else turn (`maxTurns`), else make do. Settling sets home, places the bed and a chest and stores the `stash` kinds.

#### Scenario: good place found
- **WHEN** the bot is 520 blocks from the old base in a plains biome with grass, trees, water and cows
- **THEN** it sets home there, places its bed and a chest, and the state is settled

#### Scenario: restart mid-way
- **WHEN** the bot restarts while travelling
- **THEN** it carries on with the stored heading and does not set home where it stands

### Requirement: No night walking
When it could not dig in `startOver.shelterTries` times in a night, the start-over SHALL wait for the morning instead of walking on.

#### Scenario: no shelter
- **WHEN** three bunkers failed tonight with the default settings
- **THEN** it waits where it is until day

### Requirement: Turn at an ocean
When every leg heading within the detours of the current one ends or passes over water or ice, the start-over SHALL turn to the best untried dry heading (while turns are left) instead of swimming, and only when it stands on land.

#### Scenario: ocean west
- **WHEN** heading west and all detours are ocean
- **THEN** it turns to an untried heading instead of swimming

### Requirement: Range by distance walked
After a turn, the start-over range SHALL count the blocks actually walked, and a failed walk to a settle target further than `startOver.settleNear` SHALL be retried up to `startOver.settleTries` times before settling where it stands.

#### Scenario: mountains
- **WHEN** legs in the mountains move 20 blocks each
- **THEN** they use up 20 blocks of range each, not a full leg length

## REMOVED Requirements

### Requirement: Turn away from snow
**Reason**: snow was one incident's goal; replaced by Turn after rejected looks with `badBiomes`.
**Migration**: `snowTurnAfter` becomes `turnAfterRejects`.

### Requirement: Snow allowed means no snow turns
**Reason**: `allowSnow` is gone; `badBiomes: []`, `badCold: false` and `iceAsWater: true` say the same.
**Migration**: replace `allowSnow: true` with those three keys.
