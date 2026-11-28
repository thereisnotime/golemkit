# start-over Specification

## Purpose
TBD - created by archiving change start-over. Update Purpose after archive.

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
The bot SHALL walk legs in one heading by day (away from spawn and `startOver.avoid` unless `startOver.direction` is set), turning 45 then 90 degrees around blocked legs, dig in at night, and from `startOver.minDistance` look around after each leg; it SHALL settle at the first place with enough grass, logs, open water and animals that is not snowy, protected or built on, or at `startOver.maxDistance` at the best fallback place seen, else turn 90 degrees (`maxTurns`), else make do where it stands. Settling sets home, places the bed and a chest and stores ores and ingots.

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

### Requirement: Turn away from snow
After `startOver.snowTurnAfter` snowy places looked at in a row, the start-over SHALL turn its main heading 90 degrees while turns are left.

#### Scenario: frozen north
- **WHEN** three looks in a row heading north are snowy
- **THEN** the next legs head east

### Requirement: Night shelter out of protected ground
When digging in for the night fails because the spot is protected, the start-over SHALL walk on along its heading and try again without counting it as a failed try.

#### Scenario: respawned at spawn at night
- **WHEN** the bot respawns at a protected world spawn at night
- **THEN** it walks 24 blocks along its heading and digs in there

### Requirement: No night walking
When it could not dig in three times in a night, the start-over SHALL wait for the morning instead of walking on.

#### Scenario: no shelter
- **WHEN** three bunkers failed tonight
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
After a turn, the start-over range SHALL count the blocks actually walked, and a failed walk to a far settle target SHALL be retried up to 5 times before settling where it stands.

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
When every leg heading within 90 degrees of the current one ends or passes over water or ice, the start-over SHALL turn 90 degrees (while turns are left) instead of swimming.

#### Scenario: ocean west
- **WHEN** heading west and all detours are ocean
- **THEN** it turns north instead of swimming

### Requirement: Snow allowed means no snow turns
With startOver.allowSnow on, the start-over SHALL NOT turn because of snowy looks, and the site check SHALL count water and surface ice within 64 blocks.

#### Scenario: snowy taiga
- **WHEN** snow is allowed and the place has grass, trees, animals and ice 50 blocks away
- **THEN** it settles there
