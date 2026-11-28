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
