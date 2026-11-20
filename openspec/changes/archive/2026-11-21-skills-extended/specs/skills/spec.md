## ADDED Requirements

### Requirement: Crafting
The bot SHALL craft items from its inventory using minecraft-data recipes, using or placing a crafting table when the recipe needs one.

#### Scenario: Recipe needs a table and none is nearby
- **WHEN** a player asks for `craft wooden_pickaxe` and there is no crafting table within 16 blocks but the bot has planks
- **THEN** the bot crafts a crafting table, places it next to itself, crafts the pickaxe and says where the table is

#### Scenario: Missing ingredients
- **WHEN** the bot is asked to craft an item it lacks ingredients for
- **THEN** it fails with a message naming what is missing

### Requirement: Smelting
The bot SHALL smelt items in a nearby furnace, adding fuel and waiting for the output while honouring the action signal.

#### Scenario: Stop while smelting
- **WHEN** a smelt is running and the player says `!stop`
- **THEN** the bot stops polling and closes the furnace window

### Requirement: Containers
The bot SHALL deposit into, withdraw from and list chests and barrels.

#### Scenario: Deposit all keeps essentials
- **WHEN** the bot deposits `all`
- **THEN** tools, armour, food and items in the keep list stay in its inventory

#### Scenario: List an out-of-reach chest
- **WHEN** `list_container` targets a chest out of reach that the bot opened before
- **THEN** it reports the remembered contents and when it saw them, without moving

### Requirement: Farming
The bot SHALL harvest ripe crops, replant them and plant seeds on empty farmland.

#### Scenario: Unripe crops are left alone
- **WHEN** wheat nearby has age below 7
- **THEN** harvest does not break it

### Requirement: Woodcutting
The bot SHALL fell natural trees only when digging is enabled.

#### Scenario: Digging disabled
- **WHEN** `chop_tree` is called on a bot with `canDig` false
- **THEN** it fails politely without touching any block

#### Scenario: Log wall
- **WHEN** the nearest logs have no natural (non-persistent) leaves attached
- **THEN** they are not treated as a tree

### Requirement: Placing blocks and picking up items
The bot SHALL place a block at given coordinates against a solid neighbour and pick up dropped items nearby.

#### Scenario: Occupied spot
- **WHEN** `place_block` targets a spot that already holds a solid block
- **THEN** it fails with a message saying what is there
