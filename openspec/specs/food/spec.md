# food Specification

## Purpose
How keep_fed gets a hungry bot fed: an escalating ladder from what it carries, to sources it knows, to searches that widen ring by ring, to trips to known farms and villages far away, to a farm of its own, with an honest report when nothing works. The decision is the pure `planFood` in `src/skills/foodPlan.ts`.

## Requirements

### Requirement: Ladder order
keep_fed SHALL try, in order: eating ready food, cooking raw food (fuel and a furnace nearby, carried or craftable), baking bread, eating safe raw food; then a known food chest, ripe crops in range (its own or a village's), its own farm when ripe or due, a remembered food spot, animals in range beyond the breeders; then, when food is not urgent, farm work (see Parallel farming); then a search (with a trip to a known food place before the far rings); then the farm fallback; then the critical report. A step that fails SHALL be skipped for the rest of the run and the next one tried.

#### Scenario: Food in the bag
- **WHEN** the bot is hungry and carries bread while animals are in range
- **THEN** keep_fed eats instead of hunting

#### Scenario: Own farm ripe
- **WHEN** its own farm is ripe and no food is carried
- **THEN** keep_fed harvests the farm before searching or hunting further out

### Requirement: Widening search rings
keep_fed SHALL search the smallest ring of `rings` (default 48, 120, 250, 400, 600 blocks around home) that no empty search covered within `ringMemoryMinutes` (default 20). Rings wider than `farRingsFrom` (default 250) SHALL only be searched by day, even with `scoutAtNight`. An empty search SHALL cover every ring up to its radius. A wider search SHALL skip the rings a smaller one walked. A search cut short by night or mobs SHALL NOT be remembered as empty. Search records SHALL persist in agent storage.

#### Scenario: First search
- **WHEN** nothing is in range and no ring was searched recently
- **THEN** keep_fed runs find_food with radius 48

#### Scenario: Close ring empty
- **WHEN** a 48-block search came up empty 2 minutes ago
- **THEN** the next search has radius 120 and skips the rings inside 48

#### Scenario: Memory runs out
- **WHEN** every ring came up empty more than 20 minutes ago
- **THEN** keep_fed searches the 48 ring again

#### Scenario: Past the wide ring
- **WHEN** the 250 ring came up empty, no known food place is left to visit and it is day
- **THEN** the next search has radius 400, and after that one comes up empty, 600

#### Scenario: Far ring at night
- **WHEN** the 250 ring came up empty, it is night and scoutAtNight is on
- **THEN** keep_fed does not search the 400 ring and waits for day

### Requirement: Trips to known food places
With `trips` on, keep_fed SHALL take a trip to the best known food place, by day and out of danger, when the next ring is a far one or every ring came up empty. Known places SHALL be the profile's `foodPlaces` (coordinates or a remembered place name, with optional crops), its own farms, and remembered `found:<crop>`, `found:village`, `food:village_farm` and `food:animals` places. The pure `rankFoodPlaces` SHALL order them by distance divided by a trust weight (listed places and own farms 1.5, crop fields 1.2, villages 1, animals 0.6) and SHALL leave out places in another dimension, in a remembered danger zone, closer than `radius`, further than `tripRange` (default 4000) or visited recently. On a trip it SHALL walk there on the surface, harvest ripe crops and replant (the whole field for listed places and its own farms, otherwise only crops by a village), hunt animals beyond the breeders, gather a few seeds when short, bake bread, eat, and walk back home. A visited place SHALL be left alone for 20 minutes, 45 when it had nothing or could not be reached.

#### Scenario: Village before the far rings
- **WHEN** rings 48, 120 and 250 came up empty by day and the profile lists the village near -2770 1090
- **THEN** keep_fed walks to the village, harvests and replants, bakes and eats, and walks back home before it searches the 400 ring

#### Scenario: Village had nothing
- **WHEN** the trip found nothing ripe or huntable
- **THEN** the village is left alone for 45 minutes and keep_fed searches the 400 ring next

#### Scenario: No trips at night
- **WHEN** every ring came up empty and it is night
- **THEN** keep_fed does not set off for a known food place

#### Scenario: Trusted place first
- **WHEN** a listed village is 400 blocks away and a remembered field (found:wheat) 300 blocks away
- **THEN** the field comes first (300 / 1.2 = 250 against 400 / 1.5 = 267)

### Requirement: Seed gathering
gather_seeds SHALL keep breaking the nearest grass it may break, working outwards up to its radius from where it started, until it has the seeds it wants, its time limit runs out (keep_fed: `seedMinutes`, default 4), the breakable grass runs out, a break budget of about 24 blocks per seed (48 to 400) is used, or 12 grass blocks in a row can't be reached. Grass in protected areas or near the world spawn SHALL be skipped without hiding grass further out. After each break it SHALL walk over the drops next to the broken block. Its result SHALL say how many grass blocks it broke, how many seeds it got of how many wanted, and why it stopped. A seeds chore or step that came back short while breakable grass is still in reach SHALL be paused 3 minutes instead of the usual pause.

#### Scenario: No seed in the first 18 grass
- **WHEN** gather_seeds wants 5 seeds and has broken 18 grass in 108 s with no seed, and grass is still around
- **THEN** it keeps breaking grass

#### Scenario: Nearest grass protected
- **WHEN** the nearest 64 grass blocks lie inside a protected base and more grass lies further out within the radius
- **THEN** gather_seeds breaks the grass further out instead of saying there is none

#### Scenario: Short run, grass left
- **WHEN** a seeds chore got 1 of 5 seeds when its time ran out and breakable grass is still in reach
- **THEN** the seeds chore is offered again after 3 minutes, not 20

### Requirement: Reaching animals
When hunt can't get to an animal on foot (and `reach` is on, the default), it SHALL try once more with the budget from the pure `reachEffort`: up to 16 scaffolding blocks it carries (dirt, cobblestone and other stone, planks) for bridges and, for an animal above it, a pillar, and digging through or down when digging is allowed, within 45 seconds. It SHALL refuse, and say why, for an animal in a protected area or a remembered danger zone, by lava, more than 48 blocks away or more than 24 blocks above or below, or when it may neither dig nor place (or has no blocks and may not dig). While trying, the pathfinder SHALL NOT break or place in a protected area or danger zone, SHALL NOT walk through a danger zone, and SHALL NOT break a block with water or lava under it. An animal it still can't reach SHALL be left alone for 5 minutes and the hunt result SHALL say what it tried.

#### Scenario: Chicken across a gap
- **WHEN** a chicken is 20 blocks away across a ravine, the bot carries 30 dirt and the pathfinder finds no way on foot
- **THEN** hunt bridges with at most 16 dirt and kills the chicken

#### Scenario: Chicken deep in a cave
- **WHEN** a chicken is 51 blocks below the bot
- **THEN** hunt does not dig down to it, leaves it alone for 5 minutes and says it is 51 blocks below (more than 24)

#### Scenario: Animal in a protected area
- **WHEN** the only animal in range stands in a protected area
- **THEN** hunt places and digs nothing there and says it is in a protected area

### Requirement: Work while searching
While searching, find_food SHALL stop as soon as huntable animals (beyond the breeders) or a village farm come into view and remember the spot, SHALL note water, and when keep_fed asks for seeds SHALL break grass next to its path (no detours) until it has them. A waypoint over water or lava SHALL be replaced by dry ground closer in or a little round the ring, and SHALL only be skipped when every nearby candidate is known to be wet.

#### Scenario: Seeds on the way
- **WHEN** the farm fallback is on and the bot has 3 seeds with minSeeds 8
- **THEN** keep_fed asks find_food to pick up 5 seeds

#### Scenario: Waypoint at sea
- **WHEN** a waypoint lies on open water and the ground 16 blocks closer to home is dry
- **THEN** find_food walks to the dry point instead of skipping that direction

### Requirement: Breeders kept
With `keepBreeders` on, keep_fed SHALL hunt only adults beyond `keepAtLeast` of each kind and SHALL count only those as food when searching, unless health or food is 6 or less.

#### Scenario: Two cows left
- **WHEN** only two adult cows are in range with keepAtLeast 2 and the bot is not starving
- **THEN** keep_fed searches elsewhere instead of hunting them

#### Scenario: Starving
- **WHEN** food is 4 and only the two breeders are in range
- **THEN** keep_fed hunts them

### Requirement: Farm fallback
With `startFarm` on, when every ring came up empty, or searching is off, impossible or too dangerous, keep_fed SHALL tend its own farm (tend_farm) with seeds it carries, gather seeds by breaking grass when it has too few, start a farm near home once it has `minSeeds`, breed animals it has food for, and forage as a stopgap. New farms and seed walks SHALL only happen by day unless scoutAtNight.

#### Scenario: Nothing anywhere
- **WHEN** all three rings came up empty, the bot has no farm and carries 10 seeds
- **THEN** keep_fed starts a farm

#### Scenario: Too few seeds
- **WHEN** all rings are empty, the bot has 2 seeds and grass is nearby
- **THEN** keep_fed gathers seeds before starting the farm

#### Scenario: Mobs near
- **WHEN** keep_fed senses danger (shooters, 3+ hostiles close) and the bot has seeds and no farm
- **THEN** keep_fed does not search and starts a farm near home instead

### Requirement: Critical report
When food is at or below 6 and no step is left, keep_fed SHALL tell its owner once (a whisper when the owner is online), at most every 10 minutes, and SHALL NOT start far trips.

#### Scenario: Starving at night
- **WHEN** food is 5 at night and nothing is left to try
- **THEN** the owner gets one message, and none again for 10 minutes

### Requirement: Rung-dependent wait
After a run that leaves the bot hungry, keep_fed SHALL wait 20 s when another ring or step is open, 45 s while hostiles are near, 3 minutes while its crops grow, 2 minutes at night or when critical, and 5 minutes when nothing is possible; a change in its food-related inventory SHALL end the wait early. Failed steps SHALL be paused on their own schedule.

#### Scenario: Farm growing
- **WHEN** nothing is ripe and its farm has crops growing
- **THEN** keep_fed tries again in 3 minutes

### Requirement: Decisions logged
Every keep_fed decision SHALL be logged at debug level with its rung, step and reason, and every wait with its length and reason.

#### Scenario: Widening
- **WHEN** keep_fed widens the search to 120 blocks
- **THEN** the log has a line with rung=search, step=scout and "widening to 120"

### Requirement: Farm upkeep and growth
tend_farm SHALL decide its cells with the pure `planFarmWork`: plant bare farmland first, then till and plant dirt inside the farmland's current square, then add cells a ring at a time towards the target size (default 9x9 around one water block), nearest the water first. It SHALL only till cells it has seeds for, SHALL NOT use the last `seedReserve` seeds for growth, and SHALL NOT till cells out of the water's reach, blocked or protected. When the centre water is gone and it has a bucket, it SHALL put the water back. start_farm SHALL only till as many cells as it has seeds for.

#### Scenario: Pax's small farm
- **WHEN** a farm has 7 farmland cells, 5 of them bare, and the bot carries 3 seeds
- **THEN** tend_farm plants 3 bare cells next to the water and tills nothing

#### Scenario: Trampled cell
- **WHEN** a cell inside the farm's square was trampled back to dirt and the bot has seeds
- **THEN** tend_farm tills and plants it before growing the farm

#### Scenario: Growing with a reserve
- **WHEN** a fully planted 3x3 farm has dirt around it and the bot carries 12 seeds with seedReserve 4
- **THEN** tend_farm adds the 8 cells of the next ring and keeps 4 seeds

#### Scenario: Water gone
- **WHEN** the farm's water block is gone and the bot has a water bucket
- **THEN** tend_farm pours the water back and the plot can be tilled again

### Requirement: Parallel farming
With `growFarm` on, keep_fed SHALL tend its farm (when there is work it can do) or start one (with `minSeeds` seeds) before searching whenever food is at least `farmAbove` (default 14) and no known source in range applies. Below that, food SHALL come first. Between meals, the pure `farmChore` SHALL pick at most one chore at a time, by day and out of danger: tend and grow its farm within 128 blocks, break grass when the farm is smaller than `farmSize` and short of seeds, start a farm once it has `minSeeds` even while food sources exist, and breed animals near home. Each chore SHALL rest a few minutes after it ran.

#### Scenario: Not urgent
- **WHEN** food is 15, nothing is in range and its farm has bare farmland it has seeds for
- **THEN** keep_fed tends the farm before searching

#### Scenario: Hungry
- **WHEN** food is 10 and its farm has work
- **THEN** keep_fed searches for food first

#### Scenario: Seeds and no farm
- **WHEN** the bot is fed, has no farm and carries 9 seeds while animals are around
- **THEN** keep_fed starts a farm

### Requirement: Breeding near home
Between meals, with `breed` on, keep_fed SHALL breed a pair of animals within 64 blocks of home (anywhere without a home) when it has their food: wheat for cows and sheep, seeds for chickens (keeping `minSeeds` seeds), carrots, potatoes or beetroot for pigs. `keepBreeders` SHALL still spare `keepAtLeast` adults of each kind when hunting.

#### Scenario: Wheat and two cows at home
- **WHEN** the bot is fed, by day, near home, with 4 wheat and two adult cows within 24 blocks
- **THEN** keep_fed breeds them

### Requirement: Forage stopgaps
forage SHALL pick ripe sweet berries, SHALL cut kelp only from the shore (at most 2 below the surface, dry ground within 3 blocks) and keep_fed SHALL only count kelp when it can smelt it into dried kelp, and SHALL break natural oak and dark oak leaves for apples only when food is critical. Village carrots and potatoes SHALL be harvested and replanted with their own crop.

#### Scenario: Critical with only trees
- **WHEN** food is 4, nothing else is left and oak leaves are in reach
- **THEN** keep_fed forages with apples on

#### Scenario: Not critical
- **WHEN** food is 10 and only oak leaves are around
- **THEN** keep_fed does not break leaves

### Requirement: Shared danger signals
keep_fed SHALL treat as danger stay_safe's ranged danger (shooters calling for cover), 3 or more hostiles within 6 blocks, hostiles within 10 blocks at 8 health or less, and standing in a remembered danger zone. find_food SHALL NOT walk towards a waypoint in a remembered danger zone or whose straight way from the centre passes through one, and keep_fed SHALL NOT go to a remembered food spot inside one. Without a registered danger-zone helper no place counts as a zone.

#### Scenario: Two zombies at a distance
- **WHEN** two zombies are 6 blocks away and health is full
- **THEN** keep_fed still searches

#### Scenario: Zone to the east
- **WHEN** a remembered danger zone lies 60 blocks east of home
- **THEN** find_food skips the eastern waypoints beyond it
