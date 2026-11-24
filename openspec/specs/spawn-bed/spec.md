# spawn-bed Specification

## Purpose
How a bot keeps a bed at home and its respawn point on it, so a death ends at home instead of at the world spawn: tracking the respawn point, getting a bed, placing it safely, setting the point by day and by night, and how long it stays in bed at night while other players are up (`keep_spawn_bed`, the `spawn_bed` skill, the pure planner in `src/skills/bedPlan.ts`).

## Requirements

### Requirement: Respawn point tracking
The spawn_bed skill SHALL keep a respawn record in storage (`spawnBed`) with status unknown, set or lost. It SHALL mark it set, at the bed, on "Respawn point set", on lying down in a bed, and on "You can sleep only at night or during thunderstorms" or "You may not rest now; there are monsters nearby" within 4 seconds of its own bed click (1.21.1 sets the point before checking time and monsters). It SHALL mark it lost, with a reason, on "You have no home bed or charged respawn anchor", on the server's spawn reset, when the bed's block is loaded and no longer a bed, and when the bot respawns after a death more than 4 blocks from the bed. A respawn within 4 blocks of the bed SHALL confirm it.

#### Scenario: Respawn at world spawn
- **WHEN** the record says set at a bed by 561 68 -45 and the bot respawns at 546 80 39
- **THEN** the record becomes lost with "respawned at 546 80 39, 85 blocks from the bed"

#### Scenario: Day click
- **WHEN** the bot clicks its bed by day and the server answers "You can sleep only at night or during thunderstorms"
- **THEN** the record is set at that bed

### Requirement: Getting a bed
While the respawn point is not a bed within homeRange + 2 blocks of home (or that bed is gone), keep_spawn_bed SHALL take the first step that applies: click its own bed near home; place a bed from the inventory and click it; take a bed from its own chests near home; look inside one of its chests near home it never opened (by day or night, since a bed may be in it); craft a bed from 3 wool of one colour and 3 planks of one kind (crafting planks from a log first); take wool from its chests when that makes 3 of one colour; shear sheep; craft shears from 2 iron ingots when woolly sheep are in sight; hunt woolly sheep sparing spareSheep adults; by day, search the next ring around home for sheep. Without a home, with home in the Nether or the End, or away from home's dimension it SHALL do nothing.

#### Scenario: Wool but no wood
- **WHEN** the bot holds 3 white wool and no planks or logs
- **THEN** it stops with "I have the wool for a bed but no wood for 3 planks" and sets the blackboard need wood

#### Scenario: Bed in a chest it never opened, at night
- **WHEN** it is night, the bot has no bed, and its configured chest by home (placed by the owner, never looked into) holds a red bed
- **THEN** it walks home and looks inside that chest (check_chests at that position), takes the red bed and places it, instead of "it is night; I look for sheep by day"

#### Scenario: Bed broken
- **WHEN** the respawn bed's block is loaded and is air, and the bot holds a red bed
- **THEN** the next step is placing the red bed

### Requirement: Back-off
keep_spawn_bed SHALL score 24 (npc level), below safety, food and keep_tools_upgraded and above idle chores, and back off 60 seconds after a failure, doubling up to 30 minutes. With every sheep ring searched empty within ringMemoryMinutes it SHALL stop with "no sheep found within <widest ring>" and not search again until the oldest empty ring is forgotten. The back-off SHALL end early when the beds, wool, planks, logs, shears or iron it carries change.

#### Scenario: No sheep anywhere
- **WHEN** the 64, 128 and 250 rings were searched without sheep in the last 30 minutes and the bot has no wool
- **THEN** it reports "no sheep found within 250" and does not search

### Requirement: Bed placement
place_bed SHALL put the bed where both cells are free and not liquid, have a full block below and room above, are not in a protected area or danger zone, are not in front of a door, fence gate or trapdoor, are not on or beside a chest, barrel, furnace, smoker, crafting table, ladder or bed, do not plug a one-wide passage, and have a free cell next to them to stand on. The home spot itself SHALL stay free. Of the allowed spots the nearest to home SHALL win, same floor first. Beds it places SHALL be remembered as its own. The bot SHALL never break a bed, and SHALL never place or click a bed in the Nether or the End.

#### Scenario: Next to home
- **WHEN** home is on an open stone floor
- **THEN** the bed's foot is placed in a cell right beside the home spot, on the same floor

### Requirement: Night grace and asking others to sleep
When set_spawn puts the bot to bed at night, it SHALL stay in bed up to grace_seconds (default 12) and then get up, unless the night skips first. While waiting it SHALL ask the players still up to go to bed through the rate-limited chat queue: once at the start, then a reminder every ask_every_seconds (default 5), at most max_asks (default 3) messages. It SHALL ask players it sees awake; players it can't see only when the server's last "N/M players sleeping" needs more sleepers than it sees awake. Until the server reports a count it SHALL assume sleeping_percentage (default 100). Spectators and ignored players SHALL never be asked. After "Sleeping through this night" it SHALL stay in bed; after "No amount of rest can pass this night" it SHALL get up. The respawn point SHALL count as set in every case. The grace, ask on/off, interval, count, texts and ignore list SHALL be keep_spawn_bed options.

#### Scenario: Someone stays up
- **WHEN** the bot lies down at night, Robin is in sight and awake, and nobody else goes to bed
- **THEN** it says "Robin, could you hop into bed so we can skip the night?", reminds at most twice more 5 seconds apart, and gets up after 12 seconds

#### Scenario: A player in the Nether
- **WHEN** the server reports "1/2 players sleeping", Robin is in sight and awake, and Steve is online but not in sight
- **THEN** only Robin is asked
