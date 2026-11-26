# gear-progression Specification

## Purpose
How a bot gets from stone tools to iron and beyond on its own: searches that are not used up by being taken over, the iron chain (pickaxe, bucket, shield, armour, tools), the furnace by home, the bucket need, and the gear search that tries exposed ore and then its staircase mine (`src/skills/progression.ts`, `stairMine.ts`, `stairMinePlan.ts`, `src/adapters/minecraft-java/needs/`).

## Requirements

### Requirement: Searches cut short
A need search that throws or ends taken over ("replaced", "preempted", "aborted", "interrupted", "cancelled", "suspended") within its first 60 seconds SHALL be recorded as cut short, and so SHALL a search left at "started" for more than 45 minutes. Cut-short searches SHALL NOT count towards `needs.search.cooldownMinutes` or `needs.search.perDay`; the need MAY search again `needs.search.retryMinutes` (default 5) after one. Every search SHALL be recorded when it ends, however it ends.

#### Scenario: Taken over by farm work
- **WHEN** Pax's 160-block gear search is taken over by farm work after 4 seconds, six times in a day
- **THEN** the seventh search may still run, 5 minutes after the last, with its 160-block radius

### Requirement: Iron chain
The tool planner SHALL make iron items in this order: iron pickaxe, a bucket (with `bucket`), a shield (with `shield`), iron chestplate, leggings, helmet and boots (with `armour`), then the other tool kinds below iron (sword, axe, shovel). With `bucketFirst` (the blackboard need `bucket`) the bucket SHALL come before the pickaxe. Items carried or worn SHALL be left out (a water or lava bucket counts as a bucket; any iron, diamond or netherite piece covers its slot; the offhand shield counts). Ingots SHALL wait for the next item while more iron can be had now (raw iron to smelt, ore in sight, prospecting); otherwise they SHALL go to the first item further down that they pay for. Planks SHALL be the last-resort fuel for any batch of raw iron. keep_tools_upgraded SHALL have `bucket` and `shield` options, on by default.

#### Scenario: Two ingots, no ore
- **WHEN** the bot has an iron pickaxe, 2 iron ingots, planks, no bucket, no shield and no ore in sight
- **THEN** the next step is to craft a shield

#### Scenario: Worn helmet
- **WHEN** the bot wears an iron helmet and has 5 ingots, with armour on
- **THEN** it does not craft another helmet

### Requirement: Furnace by home
With no furnace within 32 blocks, smelting SHALL first walk to the furnace it remembers (within 128 blocks) or else home (within 128 blocks). A furnace it puts down SHALL be remembered as the place `furnace`, and forgotten when it is gone.

#### Scenario: Back from the mine
- **WHEN** the bot comes up from its mine with raw iron and its furnace is by home 20 blocks away
- **THEN** it smelts in that furnace and puts no new one down

### Requirement: Bucket need
A blackboard need `bucket` above 0 SHALL put the bucket first in keep_tools_upgraded's chain and make the gear need's urgency at least 0.6 while the bot holds no bucket.

#### Scenario: The farm needs water
- **WHEN** a farm behaviour sets the need `bucket` and the bot has 3 iron ingots and a stone pickaxe
- **THEN** keep_tools_upgraded crafts a bucket

### Requirement: Gear search
The gear need's search SHALL run when iron (tools, armour, a bucket or a shield) is missing and the bot has a stone pickaxe or better. By day it SHALL look for iron ore with an open face within `needs.search.radius` and mine it there; when that finds nothing, or is skipped because its mine already reached depth, and a mine trip is due, it SHALL go home, prepare a trip (pantry food, weapon) and run `dig_mine` for the raw iron the chain still needs (3 to 32); then it SHALL go home and run upgrade_tools with keep_tools_upgraded's target. When the surface search turns back for the light (sunset) and night trips may go, it SHALL go on to the mine instead of ending the search. At night it MAY run when `mine.atNight` is on and either a lit mine near home is known, or no mine is known, `mine.startAtNight` is on and the bot carries or can make at least 8 torches (coal, or charcoal from logs it carries); then it SHALL skip the surface search. A known mine that is not lit SHALL wait for the day.

#### Scenario: Pax on the frozen lake
- **WHEN** the gear need is urgent, it is day and no iron ore with an open face is within 160 blocks
- **THEN** the bot digs its staircase mine near home, comes back up with raw iron, smelts it by home and crafts an iron pickaxe

#### Scenario: First mine at night
- **WHEN** it is night, no mine is known, the gear need is urgent and the bot has 8 torches
- **THEN** the gear search starts a staircase mine near home and lights the stairs as it digs

#### Scenario: Search turned back at sunset
- **WHEN** the surface search for iron turns back because daylight is running out and night trips may go
- **THEN** the bot goes on to its mine near home instead of stopping at home

### Requirement: Committed search
A need search MAY say it is committed while it runs (`NeedSearch.committed`). While it is, the needs layer SHALL keep it running with score 45 unless another behaviour scores 45 or more. The gear search SHALL be committed from the walk home before its mine trip to the end of the upgrade after it, and keep_tools_upgraded SHALL score 0 while the gear search runs.

#### Scenario: A tree to fell
- **WHEN** the gear search is walking home for its mine trip and chop_wood_loop scores 38
- **THEN** the gear search goes on

### Requirement: Wood for the mine and the furnace
Before a mine trip from the gear search the bot SHALL fell a tree when it holds less than 3 logs' worth of wood. The tool planner SHALL NOT pick "craft a furnace" without a crafting table near, one carried, or 4 planks' worth of wood; it SHALL get logs first. A crafting table SHALL be made from a log when the planks alone are too few, and a shield's 6 planks SHALL be made from logs before crafting it.

#### Scenario: Back up with raw iron and no planks
- **WHEN** the bot has 6 raw iron, 40 cobblestone, coal, no wood and no crafting table near
- **THEN** the next step is to get logs
