# spawn-proofing Specification

## Purpose
How a bot keeps hostile mobs from spawning around its home, its own farms and listed places with torches: finding the spots a monster could spawn on, estimating their light, picking few torch spots, getting torches from coal or charcoal, placing them without breaking anything, and when to check again (`light_home`, the `light_up` action in `src/skills/lighting.ts`, the pure planner in `src/skills/lightPlan.ts`).

## Requirements

### Requirement: Survey
light_up SHALL look at every standable cell within `radius` (flat) and `y_range` (up and down) of the centre: a cell and the cell above it free of collision and liquid, with a block under it. A cell SHALL need light only when a monster could spawn there: a full, opaque floor that is not glass, leaves, ice, bedrock, barrier or magma. The light of a cell SHALL be its real block light from the chunk's light data when the client has light data for the area, raised by the light sources it can see (torch 14, lantern 15, glowstone 15, soul torch 10, lit campfire 15, lit furnace 13, lava 15, ...) minus the Manhattan distance to the source. With no light data in the surveyed chunks it SHALL use the sources alone.

#### Scenario: A lantern by the door
- **WHEN** the client has no light data and a lantern hangs 3 blocks from a grass cell
- **THEN** that cell's light is 12 and it needs no torch for a target of 8

### Requirement: Torch plan
light_up SHALL choose torch spots greedily: each pick is the allowed spot that brings the most cells below `target` up to it (a torch gives 14 at its cell, one less per block of Manhattan distance), floor torches before wall torches on a tie, then by position so the plan does not depend on input order. It SHALL stop when no cell is below target, at `max_torches`, or when no allowed spot reaches the remaining cells, and report how many cells were dark and how many are left.

#### Scenario: Flat field at target 1
- **WHEN** a dark 25 x 25 grass field is planned with target 1
- **THEN** at most 8 floor torches light every cell to 1 or more

#### Scenario: More dark than torches
- **WHEN** max_torches is 3 and the area needs more
- **THEN** it plans 3 torches and reports the cells still dark

### Requirement: Allowed torch spots
A torch SHALL only go into a cell holding air or cave air (never replacing grass, crops or anything else), against a block that is already there: on the floor when the floor is a full block that does not open a GUI and is not leaves, else on a full wall block beside the cell. It SHALL never go on farmland or a path, within a block of a door, fence gate or trapdoor, in water or a waterlogged cell, in a protected area, within `spawn_clearance` of the world spawn, where the server refused a placement before, or where one of its own torches was taken away. The bot SHALL never break or replace a block while spawn-proofing.

#### Scenario: Farm and door
- **WHEN** the area holds a wheat field on farmland, a dirt path and a door
- **THEN** no planned torch stands on the farmland, on the path or within a block of the door

### Requirement: Torches from coal or charcoal
With fewer torches than planned and `craft` on, light_up SHALL craft torches from coal or charcoal and sticks (4 per coal), sticks from planks and planks from logs. With no coal or charcoal it SHALL smelt charcoal from logs, burning planks of the same wood (never the logs being smelted), in a furnace within 32 blocks, one it carries, or one crafted from 8 cobblestone. With some torches and no way to make more it SHALL place those. With no torches, no coal or charcoal and no logs (or no furnace and fewer than 8 cobblestone) it SHALL fail with the reason.

#### Scenario: Only logs
- **WHEN** the bot has 6 oak logs, a furnace nearby and nothing else
- **THEN** it crafts oak planks, smelts charcoal from oak logs with the planks as fuel, crafts sticks and torches

#### Scenario: Nothing to make torches from
- **WHEN** the bot has no torches, coal, charcoal or logs
- **THEN** light_up fails with "out of coal and charcoal, and no logs to make charcoal"

### Requirement: Own torches
Every torch light_up places SHALL be remembered with its position and dimension (`lighting.torches`). On a later survey a remembered torch whose block is loaded and no longer a torch SHALL be forgotten and its spot remembered as taken away (`lighting.removed`); no torch SHALL be planned there again.

#### Scenario: The owner takes a torch away
- **WHEN** a torch the bot placed at 570 68 -40 is gone at the next check
- **THEN** the bot leaves 570 68 -40 alone from then on

### Requirement: When light_home runs
light_home SHALL cover home (radius), each own farm (farmRadius, at least half the farm plus 4) and the listed places. It SHALL score 18 at the npc level only by day, in survival, with block placing allowed, when an area within `maxTrip` of the bot is due: never checked, checked more than `everyMinutes` ago, or a hostile was seen inside it since the last check (each mob once). It SHALL walk to the area when farther than 24 blocks, run light_up, and mark the area checked when nothing is left dark or the run placed nothing. A failure SHALL back off 2 minutes, doubling up to an hour, and the back-off SHALL end early when the torches, coal, charcoal, logs, planks, sticks, cobblestone or furnaces it carries change.

#### Scenario: Creeper by the farm at night
- **WHEN** a creeper shows up inside farm:1's area at night after the farm was checked that afternoon
- **THEN** light_home checks farm:1 again the next morning

#### Scenario: Far from home
- **WHEN** the bot is 3000 blocks from home on a food trip
- **THEN** light_home does not run for home
