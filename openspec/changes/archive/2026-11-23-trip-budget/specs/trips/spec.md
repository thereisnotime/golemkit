## ADDED Requirements

### Requirement: Trips
A trip SHALL be a walk away from home started by a behaviour or by an action not ordered by a player: keep_fed scouting, food trips, food spots and far farm visits, farm_setup far farm visits, keep_spawn_bed scouting for sheep, chop_tree rings past `trips.minDistance` (default 64) and upgrade_tools going for ore. Walks shorter than `trips.minDistance` SHALL NOT be trips. Actions a player ordered SHALL NOT be prepared or budgeted unless `trips.ownerOrders` is on. With `trips.enabled` off nothing changes. A trip started inside another trip SHALL join it.

#### Scenario: Owner order
- **WHEN** the owner says "chop a tree" with rings out to 250 and the bot has no weapon
- **THEN** chop_tree walks out as before, without preparation or budget

### Requirement: Preparation
Before a trip the bot SHALL take food out of its own and configured chests (`settings.storage.chests`) within 160 blocks, best food first, until it carries `trips.food` items (default 8), and hold its best sword or axe. It SHALL NOT leave, and SHALL say what is missing, when it then has no weapon (`trips.needWeapon`), fewer than `trips.minFood` food items (default 4) or less than `trips.minHealth` health (default 12). Food trips SHALL NOT need food items along; a food trip with the food bar at 6 or less SHALL go whatever is missing. A wood trip with no weapon and fewer than 3 planks' worth of wood SHALL waive the weapon.

#### Scenario: Pantry top-up
- **WHEN** Pax carries 2 bread, its pantry chest holds 20 bread, and keep_spawn_bed wants to scout 120 blocks for sheep
- **THEN** it takes 6 bread, holds its stone sword and goes

#### Scenario: No weapon
- **WHEN** a bot without a sword or axe and with 8 bread would scout for sheep
- **THEN** it stays and keep_spawn_bed backs off with "not ready for a trip (looking for sheep 120 blocks out): no weapon"

### Requirement: Turn-back budget
On a trip the bot SHALL check every 2 seconds and turn back when the food left (food bar plus the food points carried) is at or below `trips.turnBackAt` (default 0.5) of what it left with, when the food bar is at or below `trips.foodFloor` (default 6) with no food carried, or when the daylight left is at most the walk home (horizontal distance / `trips.speed`, default 3 blocks a second) plus `trips.daylightMarginS` (default 60), or in a thunderstorm. Within 16 blocks of home nothing SHALL turn it back. A starving food trip SHALL have no food rule; a trip started at night or whose way back alone takes longer than a day SHALL have no daylight rule.

#### Scenario: The Pax trip
- **WHEN** keep_fed scouts the 250 ring with the food bar at 12 and no food, and the bar drops to 6 at 200 blocks from home
- **THEN** the walk stops, it walks home and tells its owner "turned back: food down to 6 of the 12 I left with (scouting 250 blocks out for food), back home"

#### Scenario: Dusk
- **WHEN** the bot is 240 blocks from home on a trip with 130 seconds of daylight left
- **THEN** it turns back (80 s of walking plus the 60 s margin)

### Requirement: After a turn-back
Travel SHALL stop mid-leg with a turn-back error once the trip turns back, except on the walk home. The behaviour or action that started the trip SHALL walk home, report "turned back: <why> (<purpose>)" to an owner online (else in chat), and fail with `data.turnedBack`; what it gathered before turning back SHALL still be reported. keep_fed SHALL NOT record a ring cut short by a turn-back as empty and SHALL start no other trip in that run.

#### Scenario: Ring not forgotten
- **WHEN** a scout of the 120 ring turns back for daylight
- **THEN** the 120 ring is searched again next time instead of being skipped as empty
