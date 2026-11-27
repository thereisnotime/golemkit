## MODIFIED Requirements

### Requirement: Use any chest
With `storage.anyContainer` on, the bot SHALL treat every container it remembers near home as its own (take from it, look into it, count its contents for materials and the pantry), still skipping protected areas. Containers are chests, barrels, shulker boxes, furnaces, smokers, blast furnaces, hoppers, droppers, dispensers, brewing stands and crafters. It SHALL only store items in chests, barrels and shulker boxes. Off, only chests it placed and `storage.chests` count.

#### Scenario: someone else's chest with cobblestone
- **WHEN** anyContainer is on and a remembered chest it did not place holds 495 cobblestone
- **THEN** the material planner counts that cobblestone and takes from it

#### Scenario: iron in a furnace
- **WHEN** anyContainer is on and a remembered furnace holds 7 iron ingots
- **THEN** those ingots count as its own and it may take them
