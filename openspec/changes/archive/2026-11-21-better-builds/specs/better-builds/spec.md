## ADDED Requirements

### Requirement: State-aware placement
The build SHALL place stairs, slabs, logs, doors, trapdoors, wall torches, ladders, beds, chests and furnaces in the block state the blueprint names, by choosing the reference block, face, cursor and look direction, and SHALL read the block back after placing.

#### Scenario: Roof stairs face the ridge
- **WHEN** a blueprint cell asks for `oak_stairs[facing=north,half=bottom]`
- **THEN** the bot looks north and clicks the top of the block below (or a side face low down) and the placed stair faces north with a bottom half

#### Scenario: Wrong facing is fixed once
- **WHEN** a placed block reads back with a wrong facing, half or axis and the bot may dig
- **THEN** it breaks the block and places it again with the next option, at most once

#### Scenario: Nothing to click yet
- **WHEN** a log along x has no neighbour on the x axis yet
- **THEN** the cell is deferred and placed after a neighbour appears, or placed plain at the end and reported

### Requirement: Blueprint states and themes
Blueprints SHALL accept block states in palette entries (object, `role[k=v]` and plain `minecraft:block[k=v]` forms), `^ v < >` stair shorthand, wood themes, fallback items, furnishing roles and an optional `meta` block, while every existing blueprint keeps loading unchanged.

#### Scenario: Rotation keeps orientation
- **WHEN** a blueprint drawn facing south is built facing west
- **THEN** every facing state turns a quarter clockwise and x/z log axes swap

#### Scenario: Wood theme
- **WHEN** the bot carries mostly spruce or the player passes `theme=spruce`
- **THEN** wood roles use spruce planks, stairs, slabs, logs, doors and fences

#### Scenario: Several blueprint directories
- **WHEN** blueprints are loaded from the shipped directory and a user directory with a blueprint of the same name
- **THEN** the later directory's blueprint wins and broken files are reported, not thrown

### Requirement: Good-looking shipped houses
The project SHALL ship `small_house` (default for "build a house"), `cottage`, `cabin` and `watchtower` blueprints with pitched stair roofs, log frames, windows, doors, lighting and furnishings, and a text preview of any blueprint.

#### Scenario: Preview
- **WHEN** `build_plan template=cottage preview=true` runs
- **THEN** the result contains a top view, every layer and a legend

### Requirement: Materials beyond planks
`gather_materials` SHALL plan and craft stairs, slabs, fences, trapdoors, doors, ladders, chests, crafting tables, furnaces, beds and glass panes, mine cobblestone with a pickaxe, make torches from coal or charcoal, glass from sand and beds from sheep wool, and report optional items it skipped.

#### Scenario: No glass
- **WHEN** there is no sand within the radius
- **THEN** the glass panes are skipped, fences are gathered instead, and the result says so

#### Scenario: No sheep
- **WHEN** no sheep are nearby
- **THEN** the bed is skipped and the build reports "skipped: bed (no wool)"

### Requirement: Site preparation and quality check
The build SHALL fill small dips and dig bumps and plants in the footprint, face the door towards the requester or an open side, never build in protected areas or over player builds, and after placing SHALL verify every planned block and state, fix mismatches once and report built/total and what was skipped.

#### Scenario: Report
- **WHEN** a cottage finishes without wool
- **THEN** the result reads like "built a cottage at x y z facing south: 238/239 blocks (...); skipped: bed (no wool)"

### Requirement: Own and mixed blocks, unreachable leftovers
The build SHALL count any block that fits a cell's role as placed regardless of the named material, SHALL remember the positions of blocks it placed and never treat them as player-made, SHALL place doors only after everything else, and SHALL finish ok with a note when only a few required blocks remain and all of them failed for reach.

#### Scenario: Rebuild with another wood
- **WHEN** a hut was partly built with oak planks and `build template=hut material=spruce_planks` runs at the same spot
- **THEN** the oak planks count as placed and the build continues instead of refusing

#### Scenario: Three blocks out of reach
- **WHEN** 194 of 197 blocks are placed and the last 3 keep failing with path timeouts after their retry
- **THEN** the result is ok and says "3 blocks unreachable at x y z, ..., skipped"

### Requirement: Creative mode
In creative mode `gather_materials` and `build` SHALL take the needed items from the creative inventory instead of chopping, mining or crafting, make no tools, fly to standing spots when needed, and report "creative: took N items from the creative inventory"; survival behaviour SHALL stay unchanged.

#### Scenario: Creative gather
- **WHEN** a bot in creative runs `gather_materials template=small_house`
- **THEN** it puts the planks, stairs, logs, slabs, door and extras into its inventory from the creative inventory and says how many items it took

## MODIFIED Requirements

### Requirement: Building from blueprints
`build` SHALL resume interrupted builds on the same site, skip blocks already right (including passive halves), refuse sites with player-made blocks, and use `small_house` as the default house in its description.

#### Scenario: Resume
- **WHEN** a build is interrupted and `build` is called again near the site
- **THEN** it continues on the same origin and facing and places only what is missing or wrong
