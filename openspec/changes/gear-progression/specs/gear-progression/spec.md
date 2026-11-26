## ADDED Requirements

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
The gear need's search SHALL run when iron (tools, armour, a bucket or a shield) is missing and the bot has a stone pickaxe or better. By day it SHALL look for iron ore with an open face within `needs.search.radius` and mine it there; when that finds nothing, or is skipped because its mine already reached depth, and a mine trip is due, it SHALL go home, prepare a trip (pantry food, weapon) and run `dig_mine` for the raw iron the chain still needs (3 to 32); then it SHALL go home and run upgrade_tools with keep_tools_upgraded's target. At night it MAY run when a lit mine near home is known and `mine.atNight` is on, and then it SHALL skip the surface search.

#### Scenario: Pax on the frozen lake
- **WHEN** the gear need is urgent, it is day and no iron ore with an open face is within 160 blocks
- **THEN** the bot digs its staircase mine near home, comes back up with raw iron, smelts it by home and crafts an iron pickaxe
