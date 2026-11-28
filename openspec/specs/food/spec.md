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
keep_fed SHALL search the smallest ring of `rings` (default 48, 120, 250, 400, 600 blocks around home) that no empty search covered within `ringMemoryMinutes` (default 180). Rings wider than `farRingsFrom` (default 250) SHALL only be searched by day, even with `scoutAtNight`. An empty search SHALL cover every ring up to its radius. A wider search SHALL skip the rings a smaller one walked. A search cut short by night or mobs SHALL NOT be remembered as empty. Search records SHALL persist in agent storage.

#### Scenario: First search
- **WHEN** nothing is in range and no ring was searched recently
- **THEN** keep_fed runs find_food with radius 48

#### Scenario: Close ring empty
- **WHEN** a 48-block search came up empty 2 minutes ago
- **THEN** the next search has radius 120 and skips the rings inside 48

#### Scenario: Memory runs out
- **WHEN** every ring came up empty more than `ringMemoryMinutes` (default 180) ago
- **THEN** keep_fed searches the 48 ring again

#### Scenario: Past the wide ring
- **WHEN** the 250 ring came up empty, no known food place is left to visit and it is day
- **THEN** the next search has radius 400, and after that one comes up empty, 600

#### Scenario: Far ring at night
- **WHEN** the 250 ring came up empty, it is night and scoutAtNight is on
- **THEN** keep_fed does not search the 400 ring and waits for day

### Requirement: Far rings need gear or hunger
A ring wider than `riskyRingsFrom` (default 48) SHALL never be started at food at or below `scoutFoodFloor` (default 6), whatever the gear, and otherwise only when the bot's gear score (the stay-safe gear score: armour, shield, weapon, bow and arrows, health) is at least `scoutGear` (default 40) or food is at or below `scoutHungerAt` (default 8). find_food SHALL walk, not sprint, and path around water where it can; when it runs out of air it SHALL swim up before heading for dry land. Otherwise the search SHALL count as blocked with a reason naming the food, the gear score and the ring, the ladder SHALL go on to baking, its farm, seeds, breeding and foraging, and the next try SHALL be no sooner than 3 minutes later. `scoutGear: 0` SHALL turn the rule off. The rule SHALL be the pure `riskyRing` in `src/skills/foodPlan.ts`.

#### Scenario: Stone tools at food 12
- **WHEN** the bot has food 12, a stone sword, no armour or shield (gear about 25), its farm growing, and the 48 ring came up empty
- **THEN** keep_fed does not search the 120 ring and waits for the crops, logging "not scouting 120 blocks out yet"

#### Scenario: Food 0 after an empty 120 ring
- **WHEN** food is 0 and the 48 and 120 rings came up empty
- **THEN** keep_fed does not start the 250 ring; it reports to its owner instead

#### Scenario: Hungry enough
- **WHEN** the same bot's food drops to 8
- **THEN** keep_fed searches the 120 ring

#### Scenario: Geared
- **WHEN** the bot wears iron armour and carries an iron sword at food 12
- **THEN** keep_fed searches the 120 ring

### Requirement: Starving comes first
With food at or below 6, keep_fed SHALL go to its own farm, a food chest or a remembered food spot within 96 blocks and search the near ring (up to `riskyRingsFrom`) also at night; wider rings SHALL not be started at all (see the food floor). Between ladder runs a starving bot SHALL score 45 (above chop_wood_loop and stay_safe's hold after a failed trip home, below stay_safe's night trip home), walk home by day when more than 16 blocks out, and otherwise wait there, so chores do not take turns with stay_safe while it starves.

#### Scenario: Food 0 at night
- **WHEN** the bot has food 0 at night and its farm is 80 blocks away
- **THEN** keep_fed goes to the farm instead of waiting for day

#### Scenario: Nothing to do yet
- **WHEN** the bot is starving, keep_fed's last run found nothing and its wait is not over, by day
- **THEN** keep_fed holds the body near home and chop_wood_loop does not run

### Requirement: Trips to known food places
With keep_fed's `trips` option on (default), keep_fed SHALL take a trip to the best known food place, by day and out of danger, when the next ring is a far one or every ring came up empty. Known places SHALL be the profile's `foodPlaces` (coordinates or a remembered place name, with optional crops), its own farms, and remembered `found:<crop>`, `found:village`, `food:village_farm` and `food:animals` places. The pure `rankFoodPlaces` SHALL order them by distance divided by a trust weight (listed places and own farms 1.5, crop fields 1.2, villages 1, animals 0.6) and SHALL leave out places in another dimension, in a remembered danger zone, closer than 48 blocks or `radius` (whichever is more), further than `tripRange` (default 4000) or visited recently. On a trip it SHALL walk there on the surface, harvest ripe crops and replant (the whole field for listed places and its own farms, otherwise only crops by a village), hunt animals beyond the breeders, gather a few seeds when short, bake bread, eat, and walk back home. These walks, its scouting rings, remembered food spots and far farm visits SHALL be trips under `settings.trips` (pantry top-up, weapon and turn-back budget; see the trips spec). A visited place SHALL be left alone for 20 minutes, 45 when it had nothing or could not be reached.

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

### Requirement: Seeds from its chests
gather_seeds (`fromChests`, default true) and tend_farm (`fromChests`, when the farm is short of seeds) SHALL first take the farm's seed (wheat seeds for gather_seeds) from its own and configured chests near home, up to what is wanted, chests known to hold seeds first, then ones it never looked into, and break grass only for the rest. The between-meals chores and the ladder's farm seeds step SHALL count seeds seen in those chests (container memory) like grass in reach. The seeds a food trip picks up far from home SHALL come from grass only.

#### Scenario: Seeds in the pantry
- **WHEN** the 9x9 farm has 1 seed planted short of 80 cells, no grass is in reach and the pantry by home holds 35 wheat seeds
- **THEN** the seeds chore runs, gather_seeds takes the seeds from the pantry and tend_farm plants them

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
When food is at or below 6, or every search ring came up empty (and no farm was just started or is growing), and no step is left, keep_fed SHALL tell its owner (a whisper when the owner is online) how far it searched and what would help (food, seeds, a pair of animals), at most once an hour, and SHALL NOT start far trips.

#### Scenario: Starving at night
- **WHEN** food is 5 at night and nothing is left to try
- **THEN** the owner gets one message, and none again for an hour

#### Scenario: Nothing within 250 blocks
- **WHEN** the 48, 120 and 250 rings all came up empty and the bot has no seeds
- **THEN** the owner hears "nothing to eat within 250 blocks of home" and that seeds or animals would help, once

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
keep_fed SHALL treat as danger stay_safe's ranged danger (shooters calling for cover), 3 or more hostiles within 6 blocks, hostiles within 10 blocks at 8 health or less, and standing in a remembered danger zone. find_food SHALL NOT walk towards a waypoint in a remembered danger zone or whose straight way from the centre passes through one, and keep_fed SHALL NOT go to a remembered food spot inside one. These checks SHALL read the agent's core danger memory directly, whether or not the combat or ranged skills are loaded, and each check SHALL read it once.

#### Scenario: Two zombies at a distance
- **WHEN** two zombies are 6 blocks away and health is full
- **THEN** keep_fed still searches

#### Scenario: Zone to the east
- **WHEN** a remembered danger zone lies 60 blocks east of home
- **THEN** find_food skips the eastern waypoints beyond it

### Requirement: Farm water on cold ground
When start_farm finds no open water it may use, no remembered water spot and no bucket, and
farming.iceWater is on (default) and digging is allowed, it SHALL look for surface ice with land
next to it within its radius, then out to 96 blocks. The ice SHALL have air or snow above it, no
roof, and water or a solid block under it. It SHALL score each site like a water site, counting the
ice as water and not as a hazard. It SHALL break the centre ice standing on the shore, with a tool
that has no Silk Touch or a bare hand, never in the Nether, and SHALL check that water is there
afterwards. Water in a cold biome (temperature below 0.15), whether open, poured from a bucket or
from broken ice, SHALL be kept from freezing as farming.protectWater says. In auto, that is a cheap
block over the water, placed against a helper block on the shore cell next to it that it takes back;
it carries two cheap blocks or takes them from its chests. Without the blocks it uses a torch on that
shore cell, which gives the water light 12, and without either, two dirt dug from just outside the plot. In cover or torch mode it uses only that one. With off,
or with neither, it SHALL not use the site and SHALL say why. Protected areas, spawn clearance,
builds nearby, bad farm sites and lava stay ruled out.

#### Scenario: Pax's frozen lake
- **WHEN** home is by a frozen lake in a snowy biome, the bot has no bucket and no torches, and its chests hold dirt
- **THEN** it takes 2 dirt from its chests, breaks the shore ice for a water source, puts a dirt block over the water and starts the farm there

#### Scenario: A torch instead
- **WHEN** it has no cheap blocks but carries torches
- **THEN** it breaks the ice and puts a torch on the shore cell next to the water, which is then not tilled

#### Scenario: Nothing to keep it open
- **WHEN** it has no cheap blocks and no torches anywhere
- **THEN** it leaves the ice alone and the failure says the water would freeze again and what it lacks

### Requirement: Seeds from its chests for a new farm
start_farm SHALL take wheat seeds from its own chests near home before it breaks grass for them.

#### Scenario: Seeds in the pantry
- **WHEN** it has 0 seeds and its pantry holds 35
- **THEN** it takes the seeds it needs from the pantry and breaks no grass

### Requirement: Shore farms judged on their land
A new farm SHALL remember which cells of its square were land when it was made, where its water came
from, and what keeps the water open. Site health SHALL count only those cells when it decides whether
the farm is flooded. A frozen centre SHALL mark it bad, and so SHALL half of those cells turned to
water or ice. Farms without the record SHALL be judged on the dry field left: half the square wet
counts as flooded only when fewer than 8 dry cells (farmland or tillable) remain.

#### Scenario: Lake beside the farm
- **WHEN** a shore farm has half its square on the lake and its centre water is open
- **THEN** the site check says it is fine

#### Scenario: The water froze
- **WHEN** the centre of a shore farm is ice
- **THEN** it is marked bad ("the water froze")

#### Scenario: An older shore farm
- **WHEN** a farm without a land list has 46 of 80 cells water or ice and 34 farmland
- **THEN** the site check says it is fine

### Requirement: Food sources in order
farm_setup SHALL pick its long-run food source from settings food.sources (default repair, farm,
plot, animals, fish, forage): the first one the bot and the area allow. A lasting source (repair,
farm, plot) whose farm already stands SHALL win in its place and be tended; one that is not set up
yet SHALL be set up. A stock source (animals, fish, forage) SHALL run only while the food items it
carries plus those in its chests near home are below food.stock (default 12). A source that failed
SHALL be skipped for food.retryMinutes (default 60). A source left out of the list SHALL never be
used. The choice SHALL be reported with the reason for each source skipped before it, in
farm_setup's results, the food_sources action and the food skill's observation.

#### Scenario: Frozen shore, no farm, a base plot
- **WHEN** the bot has a bad farm it gave up on, start_farm failed 12 minutes ago, it has 3 seeds and its base keeps a farm plot
- **THEN** the active source is plot, and the status says why repair and farm were skipped

#### Scenario: Plenty of food
- **WHEN** fishing is the first source that fits and the bot has 20 food items
- **THEN** fish is the active source but no fishing session runs

### Requirement: Bad farms repaired or moved
When one of its farms is marked bad, repair_farm SHALL decide by farming.badFarm (default auto):
put it back when it reads fine now; in auto repair it when the job is small (at most
farming.repairMaxBlocks, default 16, flooded cells to fill with dirt; frozen centre water that can
be broken without Silk Touch and kept open; the centre water put back only with a bucket) and move
otherwise; in repair never move and tell the owners when it can't; in relocate never repair; in off
do neither. Water running over most of the field from above SHALL mean moving. After
farming.repairTries (default 2) repairs that didn't take it SHALL give up on that farm. A repaired
farm SHALL go back on its list, with its land cells recorded when it had none.

#### Scenario: Frozen centre
- **WHEN** a farm's centre water froze and it has a cheap block or a torch
- **THEN** it breaks the ice, keeps the water open and the farm goes back on its list

#### Scenario: Big flood
- **WHEN** 30 field cells are under water
- **THEN** in auto it starts a new farm elsewhere, in repair it leaves the farm and tells the owners

### Requirement: The base's farm plot
plot_farm SHALL turn the plot kept by the farm_plot base project into a farm when farming.plot is
on (default). With farming.plotWater auto (default) it SHALL use water within 4 blocks of every cell
(at its height or one above), else ice it carries broken in the middle without Silk Touch, else a
dry plot with a torch in the middle. It SHALL till only as many cells as it has seeds and plant each
at once. It SHALL put torches up until every crop cell has light 9 or more, and in a cold biome under
the sky a torch close enough to give the middle water light 10. Stone or sand cells SHALL be swapped
for dirt only with farming.plotSwap on and dirt to hand. The farm SHALL be tended like any farm but
never grown past the plot.

#### Scenario: Pax's plot
- **WHEN** the plot is grass inside open walls in a snowy biome, there is no water near and no ice item, and it has 3 seeds and torches
- **THEN** it puts a torch in the middle, tills and plants 3 cells and saves the farm as a dry plot

### Requirement: Own builds are not somebody's build
With farming.ownBuilds on (default), blocks it placed, its torches, its finished builds, its farms
(healthy or bad, with the fence ring) and farming.ownBaseRadius (default 12) blocks around its base
SHALL NOT rule a farm site out as somebody's build. A site ruled out for a build SHALL name the block.

#### Scenario: Its own torches by the lake
- **WHEN** the only placed blocks near a shore ice site are torches it put up
- **THEN** the site is not ruled out as somebody's build

### Requirement: Starving takes the closest sure food
With food at or below `starvingRangeAt` (keep_fed default 8), keep_fed SHALL skip its farm, remembered food spots and known food places further than `starvingRange` (default 96 blocks) and use near sources (chests, crops in range, hunting in range, fishing near home) instead.

#### Scenario: a village 3500 blocks away
- **WHEN** food is 5, the inner rings came up empty and the only known place is a village 3500 blocks away
- **THEN** keep_fed does not start a trip there

#### Scenario: one above critical
- **WHEN** food is 7 and the only known place is 3500 blocks away
- **THEN** keep_fed does not start a trip there (it would turn back at the trip food floor of 6)

### Requirement: Rotten flesh as a last resort
With food at or below `eatRottenAt` (default 6; 0 turns it off) and no better food carried, keep_fed SHALL eat rotten flesh it carries.

#### Scenario: starving with rotten flesh
- **WHEN** food is 5, nothing else edible is carried and it has 18 rotten flesh
- **THEN** it eats rotten flesh before looking further

### Requirement: Fishing near home
keep_fed SHALL fish when it has a fishing rod or can get one (from its chests, or crafted from 2 string and 3 sticks it carries or takes from its chests) and there is open water or lake ice within `fishRange` (default 48) of home; after hunting, before trips and searches; by day, or at night when starving; never with hostiles near.

#### Scenario: string in the chest, water by the base
- **WHEN** it is hungry, has no animals in range, its chest holds 3 string and open water is 25 blocks from home
- **THEN** it takes the string, crafts a rod and fishes

### Requirement: Bread from wheat in its chests
When the wheat it carries and the wheat in containers it may take from add up to 3 or more, keep_fed SHALL take the wheat and bake bread.

#### Scenario: one wheat in each of two chests and one carried
- **WHEN** it carries 1 wheat and its chests hold 1 each
- **THEN** it takes both and bakes a bread
