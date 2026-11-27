## MODIFIED Requirements
### Requirement: Torches
With `mining.torches` on (default), the miner SHALL place a torch on the tunnel floor behind it every `torchEvery` (default 8) steps below the surface when the spot has block light under 8, crafting torches from coal or charcoal and a stick when it has none. In a staircase mine with no torch yet, the first SHALL go after `mining.firstTorchAt` (default 4) steps.

#### Scenario: Coal from the strip
- **WHEN** the bot has mined coal and holds sticks but no torches, 8 steps into the tunnel
- **THEN** it crafts torches and places one behind it

#### Scenario: A short first trip
- **WHEN** the first trip down a new mine turns back after 5 stair steps
- **THEN** the stairs already have a torch and the mine counts as lit

### Requirement: Underground retreat
Underground, at or below `mining.retreatBelow` health (default 10), with `mining.retreatHostiles` (default 2) hostiles within `mining.hostileRadius` blocks (default 8, a live toggle), or with 6 air or less, the miner SHALL abandon the dig and walk back up the way it came, collect SHALL stop and climb out, and the reflexes SHALL run climb_out instead of defend (also with no mob near while health keeps dropping), whatever reflexes.retreatBelow says. A hostile standing under open sky SHALL count only within `mining.hostileClose` (default 4) blocks unless `mining.surfaceHostiles` is on. A melee mob right on the bot at its level MAY still be fought (keepClimbing). On the surface these rules SHALL NOT apply.

#### Scenario: Flooded cave
- **WHEN** the bot collecting iron ore at y 33 is under water with 4 air left
- **THEN** it stops collecting and climbs out

#### Scenario: Creeper and zombie in a cave
- **WHEN** the bot is at y 10 under 50 blocks of rock with 8 health and a creeper and a zombie 5 blocks away
- **THEN** it climbs out instead of fighting

#### Scenario: Zombies over the entrance
- **WHEN** the bot is 5 steps down its mine at night and two zombies walk on the surface 5 blocks above, 6 blocks away
- **THEN** it keeps digging

## ADDED Requirements
### Requirement: Relighting a known mine
With `mine.relight` on (default) and torches carried or craftable, `dig_mine` SHALL, on the walk down a known mine, stop at the remembered dark stair stands where a torch is due (the first after `mining.firstTorchAt` steps in a mine with none, then every `mining.torchEvery` steps; a lit stand restarts the count) and put a torch on the step above, adding it to the mine's torch count.

#### Scenario: Pax's unlit mine
- **WHEN** the bot walks down a 5-step mine with no torches and carries 16
- **THEN** it puts a torch at step 4 and the mine counts as lit for night trips
