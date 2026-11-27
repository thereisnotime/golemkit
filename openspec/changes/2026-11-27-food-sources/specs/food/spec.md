## ADDED Requirements

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

## MODIFIED Requirements

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
