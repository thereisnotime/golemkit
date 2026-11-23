# wood-tools Specification

## Purpose
How a bot keeps itself in wood and tools without help: planks counted per kind, a sword early, wood from its own chests, a wood need that the wood behaviour picks up, prompt retries once wood is back, and a tree search that widens ring by ring (`nextTreeStep` in `src/skills/treePlan.ts`).

## Requirements

### Requirement: Planks of one kind
Tool and stick crafting SHALL count wood per plank kind: a plank kind with a single plank and no log in the inventory that turns into it SHALL count for nothing. Before crafting sticks or a tool, the bot SHALL craft planks from its logs until one kind has enough for the recipe, preferring the kind it already holds most of.

#### Scenario: Mixed planks and logs
- **WHEN** the bot holds 1 oak plank, 1 spruce plank, 8 spruce logs and no sticks, and needs 2 sticks
- **THEN** it crafts spruce planks from one log and then the sticks

#### Scenario: Mixed planks only
- **WHEN** the bot holds 1 oak plank, 1 spruce plank, no logs and a wooden pickaxe, and has cobblestone
- **THEN** the next upgrade step is to get logs, not to craft a stone pickaxe

### Requirement: Sword early
The tool kinds SHALL be upgraded in the order pickaxe, sword, axe, shovel. A bot with a pickaxe, no sword and fewer than 2 cobblestone SHALL craft a wooden sword when its usable wood covers the blade, the sticks for the sword and for every stone tool still to come, and a crafting table if none is near.

#### Scenario: Stone tools
- **WHEN** the bot has a stone pickaxe, no sword and 5 cobblestone
- **THEN** the next step is a stone sword

### Requirement: Wood for tools
When the next upgrade step needs logs, upgrade_tools SHALL first take logs, then planks of one kind, from the bot's own chests (placed by it or listed in storage.chests) within 48 blocks that are not in a protected area, then fell a tree within 32 blocks. When neither gives wood it SHALL fail with a message starting "needs wood" and data.need = 'wood'.

#### Scenario: Wood in the chest
- **WHEN** an own chest 10 blocks away holds spruce logs and the bot needs sticks
- **THEN** it takes logs from the chest and crafts the tool

### Requirement: Wood need and prompt retry
keep_tools_upgraded SHALL set the blackboard need `wood` when upgrade_tools fails with need 'wood' and clear it otherwise. chop_wood_loop SHALL score 38 instead of 30 while the need is set, even with `keep` logs in stock, and clear the need when a run brings wood. A behaviour MAY define retryKey; when a failed behaviour's key differs from its value at the failure, at least 10 seconds after it, the failure back-off SHALL end. keep_tools_upgraded's key SHALL be the usable wood it holds after a wood failure.

#### Scenario: Wood arrives during the back-off
- **WHEN** keep_tools_upgraded failed for wood 20 seconds ago with a 60 second back-off and the bot now holds logs
- **THEN** it runs again on the next tick

### Requirement: Stations outside spawn protection
When crafting or smelting needs a crafting table or furnace and none is near, the bot SHALL put one down on a spot outside the server's spawn protection (a square of `world.spawnProtection`, default 16, around the world spawn), outside protected areas and not on a spot the server refused in this session. When every spot next to it is inside spawn protection it SHALL walk out through the nearest side of the square first. A refused placement SHALL be reported as the server refusing it, with the likely reason (spawn protection with the distance to the world spawn, or a protected area), SHALL be marked as protected (confirmed when inside spawn protection) and the next try SHALL use another spot, up to 4 tries. The spot rules SHALL be pure (`src/skills/stationPlan.ts`).

#### Scenario: Respawned at the world spawn
- **WHEN** the bot respawned at the world spawn with logs and needs a crafting table
- **THEN** it walks out of the 16-block square and places the table there

#### Scenario: Refused placement
- **WHEN** the server refuses a crafting table on snow at 544 78 47, 2 blocks from the world spawn
- **THEN** the message says the server refused it because of spawn protection, not that the block is still snow

### Requirement: Wood ladder
chop_tree with `rings` and chop_wood_loop (option `rings`, default 32, 64, 128, 250) SHALL look for a natural tree in this order: remembered tree spots within the widest ring, nearest first, not found empty within 30 minutes; then the smallest ring no empty search covered within 20 minutes. Rings up to 64 blocks SHALL be a scan from where the bot stands; wider rings SHALL be a scouting spiral out to the ring, by day, that stops at the first natural tree. Spots and waypoints in protected areas, in or across remembered danger zones SHALL be skipped. Natural trees seen while felling or scouting SHALL be remembered in agent storage and journalled as found events. After felling a tree more than 48 blocks away the bot SHALL walk back to where it started. A scouting trip cut short SHALL NOT be remembered as an empty ring.

#### Scenario: Trees near home cut down
- **WHEN** no natural tree is within 32 or 64 blocks and those rings came up empty in this run
- **THEN** the bot scouts the 128 ring, fells the first tree it finds, remembers the spot and walks back

#### Scenario: Remembered trees
- **WHEN** the bot remembers trees 140 blocks east that it has not found empty lately
- **THEN** it walks there and fells one before searching rings

#### Scenario: Every ring empty
- **WHEN** every ring came up empty in the last 20 minutes and no remembered spot is left
- **THEN** chop_tree fails saying when it will look again
