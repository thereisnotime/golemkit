## ADDED Requirements

### Requirement: Tool progression planner
The bot SHALL decide its next tool upgrade with a pure function of its inventory, what it has seen nearby and the game mode, going wood, stone, iron, diamond, and stopping at the best tier it can reach.

#### Scenario: Stone tools as soon as possible
- **WHEN** the bot has a wooden pickaxe, no stone tools and stone nearby
- **THEN** the next step is to mine enough cobblestone for every stone tool in one trip

#### Scenario: Iron without coal
- **WHEN** the bot has stone tools, raw iron, a furnace and logs but no coal
- **THEN** it smelts a few raw iron with planks, or first makes charcoal from logs when there is more iron

#### Scenario: No iron known
- **WHEN** the bot has stone tools and has seen no iron ore and holds no iron
- **THEN** there is no further step and upgrade_tools says it stopped at stone

#### Scenario: Creative mode
- **WHEN** the bot is in creative mode
- **THEN** it takes the tools with creative_get and never gathers

### Requirement: upgrade_tools action
The bot SHALL provide an `upgrade_tools` action that performs the upgrade steps it can do now and reports each step and the tool tiers it ends with.

#### Scenario: Wood to stone
- **WHEN** a bot with a wooden pickaxe and planks runs upgrade_tools near stone
- **THEN** it mines cobblestone, crafts stone tools and reports them

### Requirement: Automatic cheap upgrades
Long gathers SHALL first do cheap upgrades: stone tools once a pickaxe exists, iron only when the iron is already in hand.

#### Scenario: Cobblestone from scratch
- **WHEN** a bot with an empty inventory runs gather_materials for 64 cobblestone
- **THEN** it chops wood, crafts a wooden pickaxe, mines 3 cobblestone, crafts a stone pickaxe and mines the rest with it

### Requirement: keep_tools_upgraded behaviour
An armable behaviour SHALL re-craft worn tools and upgrade tools up to a configured tier when the bot is idle.

#### Scenario: Worn pickaxe
- **WHEN** the best pickaxe has less than `minDurability` left and no spare
- **THEN** the behaviour crafts a new one of the same kind and tier through craft

### Requirement: Safe stone mining
The bot SHALL get stone from reachable and exposed blocks first and otherwise dig a staircase and a short strip mine, never straight down, never next to lava or water, never onto a missing floor, only through natural blocks outside protected areas.

#### Scenario: Lava ahead
- **WHEN** the next step of the staircase would open a block next to lava
- **THEN** the bot turns and tries another direction, and stops with the reason when every direction is unsafe

#### Scenario: Cave below
- **WHEN** the floor under the next standing spot is air
- **THEN** the step is refused

### Requirement: Every felled log reaches the inventory
Woodcutting SHALL collect the whole tree, including logs above reach, and report how many felled logs ended up in the inventory and why any did not.

#### Scenario: Tall spruce
- **WHEN** logs remain above reach after the trunk is cut from the ground
- **THEN** the bot pillars up inside the trunk column, cuts them, removes its pillar and sweeps the drops

#### Scenario: Ingredients stuck in the crafting grid
- **WHEN** a 2x2 craft in the inventory leaves items in the crafting grid on the server
- **THEN** the bot re-syncs the inventory and moves them back before counting what it made

#### Scenario: Full inventory
- **WHEN** the inventory is full before crafting or chopping
- **THEN** the bot throws away junk to make room, and stops with "inventory full" if that is not enough

### Requirement: Wall material choice
`gather_materials template=...` without a material SHALL pick between planks and cobblestone when the template's material role accepts both.

#### Scenario: Few trees
- **WHEN** the trees around give fewer planks than the walls need and there is stone and a pickaxe
- **THEN** it gathers cobblestone

#### Scenario: No pickaxe
- **WHEN** the bot has no pickaxe and no wood for one
- **THEN** it gathers planks

### Requirement: Measured speed
Gathering results SHALL report how long they took, and mining SHALL report blocks broken per minute.

#### Scenario: Mining report
- **WHEN** a strip mine finishes
- **THEN** the result says how many blocks it broke, in how many seconds and the rate per minute
