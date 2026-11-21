## ADDED Requirements

### Requirement: Scouting for food
The bot SHALL scout beyond its keep_fed radius for huntable animals or village farms when nothing edible is in range, in an expanding spiral around home up to a configurable distance (default 200 blocks), by day unless configured otherwise, skipping open water, lava and protected areas.

#### Scenario: No animals near spawn
- **WHEN** keep_fed runs with scouting on, the bot is hungry, carries no food and sees no huntable animals within its radius
- **THEN** it runs find_food, stops walking as soon as huntable animals come into view, remembers the spot as `food:animals` and hunts there

#### Scenario: Night falls while scouting
- **WHEN** it becomes night during a scout and scoutAtNight is false
- **THEN** scouting stops with "stopped: night fell" and keep_fed does not start another far trip until morning

#### Scenario: Nothing found
- **WHEN** the scout covers its waypoints or runs out of time without seeing food
- **THEN** the result says how far and in which directions it scouted and why it stopped, e.g. "scouted 192 blocks east and north-east of home, no animals or village crops; stopped: walked 24 legs"

#### Scenario: Stuck in one direction
- **WHEN** a leg towards a waypoint gets stuck (lake, cliff)
- **THEN** waypoints further out in that direction are skipped and the other directions are still scouted

### Requirement: Remembered food spots
The bot SHALL remember where it saw animals, village farms and water, with timestamps, and go to the best fresh spot before scouting again.

#### Scenario: Spot found empty twice
- **WHEN** the bot visits a remembered animal spot and finds nothing there on two visits in a row
- **THEN** the spot is forgotten

### Requirement: Starting a farm
The bot SHALL be able to start its own farm: collect seeds from grass, make a hoe if needed, pick flat grass or dirt next to water near home outside protected areas, the world spawn and other players' builds or fields, till a plot of up to 9x9 around the water, plant it, fence and light it when it has the materials, and register it as a named place `farm:<n>`.

#### Scenario: Empty-handed bot near a pond
- **WHEN** start_farm runs with digging enabled, an empty inventory, grass and trees nearby and a pond with grassy banks within 48 blocks of home
- **THEN** it breaks grass for wheat seeds, chops logs and crafts a wooden hoe, tills the bank around one water block, plants the seeds and reports "started a 9x9 wheat farm at x y z (farm:1)"

#### Scenario: Water next to a house
- **WHEN** the only water nearby is within 3 blocks of planks, cobblestone, fences or farmland
- **THEN** that site is not used

#### Scenario: Digging disabled
- **WHEN** start_farm runs on a bot with canDig false
- **THEN** it fails with "I need digging enabled to till a farm"

### Requirement: Breeding and herd keeping
The bot SHALL breed a pair of adult animals when it has their food (cows and sheep with wheat, pigs with carrots, potatoes or beetroot, chickens with seeds), and SHALL leave at least keepAtLeast adults of each kind when hunting unless it is starving.

#### Scenario: Two cows left
- **WHEN** keep_fed sees two cows and keepAtLeast is 2 and the bot's health and food are above 6
- **THEN** it does not hunt them and looks for food elsewhere

#### Scenario: Breeding keeps seeds
- **WHEN** the bot has 9 wheat seeds and sees two chickens
- **THEN** breed does not feed them, because 8 seeds are kept for replanting

### Requirement: farm_setup behaviour
The behaviour library SHALL include `farm_setup`, which by day and when not hungry starts a farm if the bot has none, tends it when ripe or due, bakes bread from wheat and breeds animals.

#### Scenario: Armed on a bot without a farm
- **WHEN** farm_setup is armed on a survival bot with digging enabled and grass nearby
- **THEN** it runs start_farm, and later harvests and replants `farm:1` when enough crops are ripe

## MODIFIED Requirements

### Requirement: keep_fed
keep_fed SHALL try, in order: eat, cook, bake bread, (eat safe raw food), withdraw from a known chest, harvest crops in range on its own or a village farm, harvest its own farm further away, go to a known food spot, hunt above keepAtLeast, scout, and start a farm; it SHALL never take crops from fields that are neither its own nor a village's unless anyCrops is set, and its options (`scout`, `scoutRadius`, `scoutAtNight`, `keepAtLeast`, `places`, `startFarm`, `anyCrops`) SHALL be configurable per profile and live with behavior_configure.

#### Scenario: Live configuration
- **WHEN** an owner says `!behavior_configure keep_fed scout=true scoutRadius=200`
- **THEN** the running keep_fed uses the new options at once and keeps them across restarts

#### Scenario: Player's field nearby
- **WHEN** ripe wheat with no villagers around is within range and is not one of the bot's farms
- **THEN** keep_fed does not harvest it

#### Scenario: Creative mode
- **WHEN** the bot is in creative mode
- **THEN** keep_fed and farm_setup score 0
