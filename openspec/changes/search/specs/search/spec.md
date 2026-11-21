## ADDED Requirements

### Requirement: Target resolution
The bot SHALL turn a player's word into something it can look for: ore families (stone and deepslate variants), logs, crops, water and lava, mobs, structures (village, nether portal, chest), biomes, plain block and item names, and modded names from the registry sync, ignoring case, articles and plurals.

#### Scenario: Ore family
- **WHEN** a player asks to find "iron"
- **THEN** both iron_ore and deepslate_iron_ore count, and fetching gives raw_iron

#### Scenario: Plural mob
- **WHEN** a player asks to find "cows"
- **THEN** cow entities count

#### Scenario: Unknown word
- **WHEN** the word matches nothing on the server
- **THEN** find_target fails with "I don't know what ... is" and up to six similar names

### Requirement: Finding things
find_target SHALL look at what is loaded around the bot first, then remembered spots, then scout an expanding spiral on the surface with the find_food safety rules, and for ores optionally prospect with the safe strip mine. On success it SHALL remember the spot as `found:<target>`, record a journal event and report coordinates, distance and direction from the owner (or from where it started when it can't see the owner), and come back to the owner unless `go` is set.

#### Scenario: Something in sight
- **WHEN** a player asks for water and a water source with open air above is loaded within 96 blocks
- **THEN** it answers "in sight: water at x y z, N blocks <direction> of you, remembered as found:water" without walking anywhere

#### Scenario: Scouting for it
- **WHEN** nothing is loaded within view and it is day
- **THEN** it scouts the spiral, stops a leg as soon as the target comes into view, reports what it found and walks back to the player

#### Scenario: Night falls
- **WHEN** it is night and at_night is false
- **THEN** it does not scout and says so in the result

#### Scenario: Go and stay
- **WHEN** find_target runs with go=true and finds the target
- **THEN** it walks there and stays

### Requirement: Recognising structures
The bot SHALL recognise a village from beds, bells, villagers, job sites and paths close together, and a nether portal from a lit portal or an obsidian frame.

#### Scenario: Bell and beds
- **WHEN** a bell and beds are within 48 blocks of each other
- **THEN** it counts as a village

#### Scenario: Two villagers alone
- **WHEN** only two villagers are around, with no beds or bell
- **THEN** it is not a village

#### Scenario: Unlit frame
- **WHEN** obsidian outlines a 4x5 vertical rectangle without its corners
- **THEN** it counts as a nether portal frame

### Requirement: Bringing items
bring_item SHALL get the item from its inventory, then its own chests, then by crafting (simple recipes, ingredients obtained the same way), then by gathering, then by finding the source; then walk to the player, follow them if they move, toss the items while looking at them and report how many were really handed over and picked up.

#### Scenario: Planks from trees
- **WHEN** a player asks for 16 oak_planks and the bot has none
- **THEN** it chops a tree, crafts the planks, picks up any crafting table it put down, walks to the player and reports "gave <player> 16 oak_planks"

#### Scenario: Bread from a village farm
- **WHEN** a player asks for 2 bread, the bot has no wheat and a village farm is near
- **THEN** it harvests ripe wheat (replanting), crafts the bread and hands it over

#### Scenario: Iron ingots
- **WHEN** a player asks for iron_ingot and the bot has none
- **THEN** it mines raw iron, crafts a furnace from cobblestone if it has none, smelts the iron and hands the ingots over

#### Scenario: Not picked up
- **WHEN** the tossed items are not picked up within 4 seconds
- **THEN** the result says they are lying next to the player, not that they were given

### Requirement: Only its own chests
The bot SHALL take items only from chests it placed itself or that are listed in `settings.storage.chests`.

#### Scenario: A player's chest nearby
- **WHEN** a chest it did not place and that is not configured holds the item
- **THEN** bring_item does not open it

### Requirement: Fetching drops
fetch_drops SHALL go to where a player died (from the death message and where it last saw them, or given coordinates) when it can get there before the items despawn, pick up what is there and hand it back, reporting what it found truthfully.

#### Scenario: Too far
- **WHEN** the walk would take longer than the time left before the items despawn
- **THEN** it does not go and says how far it is and how long is left, unless try_anyway is set

#### Scenario: Nothing there
- **WHEN** it arrives and no items are lying around
- **THEN** it fails with "nothing left at x y z" and comes back

### Requirement: Not drowning on the way
Long walks SHALL stop and swim up when the bot's air runs low, instead of following the path along a lake bed.

#### Scenario: Path through a deep lake
- **WHEN** the bot's air drops below 12 of 20 during travel
- **THEN** it swims straight up, carries on, and after the third time fails with "kept running out of air under water"

### Requirement: Long-running jobs
All three actions SHALL honour the action's abort signal, report progress to the asking player at milestones at most every 20 seconds (found and done always), and include the elapsed time in the result.

#### Scenario: Stopped mid-search
- **WHEN** the owner says stop during a scout
- **THEN** the action ends at once without reporting a find
