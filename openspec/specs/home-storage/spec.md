# home-storage Specification

## Purpose
Where the bot stores what it doesn't need and how the owner marks what each chest is for: chest roles in `settings.storage.chests`, what `deposit_when_full` keeps, which chest takes what, and putting down a new chest of its own near home when its chests are full (`src/skills/storagePlan.ts` for the pure parts, `src/skills/containers.ts` for `deposit`, `place_chest` and `check_chests`, the behaviour in `behaviors/work.ts`). Docs in `docs/guide/behaviors.md#storing-at-home-deposit-when-full` and `docs/guide/search.md#chest-roles`.

## Requirements

### Requirement: Chest roles
`settings.storage.chests` entries SHALL be accepted as `[x, y, z]`, `"x y z"`, `{ x, y, z }` or `{ at: <one of those>, role: pantry | storage | gear }`. Without a role the first chest SHALL be the pantry and the others storage; an unknown role SHALL count as no role; a bad position SHALL be skipped. Chests the bot placed SHALL be storage.

#### Scenario: Old profile
- **WHEN** a profile lists `chests: [[559, 69, -47], [561, 69, -47]]`
- **THEN** 559 69 -47 is the pantry and 561 69 -47 is storage

### Requirement: What it keeps
deposit_when_full SHALL never store tools, armour, shields, beds, food, items in `keep`, or arrows while it has a bow; SHALL keep up to `seeds` (default 32) seeds of each kind; SHALL keep iron (ingots, raw iron) and coal or charcoal while an iron pickaxe, sword, axe or shovel, or with `armour` (default true) an iron armour piece, is still missing; and SHALL keep a small crafting stock (8 logs, 16 planks, 16 sticks, 16 cobblestone, 16 coal, a crafting table, a furnace, a bucket, 2 chests, torches). It SHALL not run when nothing is left to store.

#### Scenario: Gear stays
- **WHEN** the inventory is full and holds a shield, a red bed, 9 iron ingots with stone tools, 50 wheat seeds and 96 snowballs
- **THEN** it stores the snowballs and 18 seeds and keeps the shield, the bed, the iron and 32 seeds

### Requirement: Which chest
Only its own and configured chests near home SHALL be used, never one in a protected area. The pantry SHALL take food only and a gear chest gear only (tools, armour, beds, ingots, diamonds, raw ores). Its own placed chests SHALL come before configured storage, ones already holding the item first; a chest it never looked into SHALL count as having room after the known ones. The `deposit` action without a position SHALL skip pantry chests for anything but food, and at a pantry's position SHALL store only the food.

#### Scenario: Pantry full of snowballs
- **WHEN** the pantry is full and the second chest by home (storage) has room
- **THEN** snowballs, gunpowder, leads, saplings and dirt go into the second chest and nothing but food into the pantry

### Requirement: A new chest when full
When none of its chests has room and it may place blocks (`placeChest`, default true, and a home in this dimension), deposit_when_full SHALL run place_chest: craft a chest from 8 planks if it has none, and put it on a free cell within `range` (6) of home with a full block under it and air above, not the home cell, not on a path, farmland, slab or stairs, not beside a door, gate, trapdoor, path, another chest, furnace, table or bed, not in a one-wide passage, a protected area, a danger zone or its farm, with somewhere to stand; a spot with a roof over it only when nothing outside works. The chest SHALL be remembered as its own storage.

#### Scenario: Storage full
- **WHEN** every chest by home is full and the bot carries planks
- **THEN** it crafts a chest, places it outside a few blocks from home and stores the items there

### Requirement: Looking into one chest
check_chests with x y z SHALL look inside just that chest when it is one of the bot's own or configured chests and refuse any other.

#### Scenario: Someone else's chest
- **WHEN** check_chests is asked for a chest that is neither placed by the bot nor configured
- **THEN** it fails with "is not one of mine" without opening it
