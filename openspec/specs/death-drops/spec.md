# death-drops Specification

## Purpose
Getting the bot's own things back after a death before they despawn, when they can still be had and the spot is safe enough (`src/skills/recoverPlan.ts`, `src/skills/recover.ts`, the `recover_drops` behaviour).

## Requirements

### Requirement: Death record
The `recovery` skill SHALL keep a snapshot of everything the bot carries (armour, inventory, hotbar, offhand) that an empty inventory only replaces after 3 seconds, and on the bot's own death SHALL record the position, dimension, the snapshot as the lost items, hostiles within 8 blocks counted by type, day or night, and whether the spot had open sky. The cause, killer and recent damage SHALL come from the death report (`deathCause`) once it arrives.

#### Scenario: Inventory emptied before the death event
- **WHEN** the server empties the inventory a moment before the death event
- **THEN** the lost items are the last full snapshot, not an empty list

### Requirement: Recovery decision
`recoverDecision` (pure, `src/skills/recoverPlan.ts`) SHALL answer go, wait or skip for a death and the world after the respawn. It SHALL skip, with the drops marked as gone, when nothing was carried, the inventory was kept, the position is unknown, the bot died in lava (or lava was the last damage), in the void or below the world, in another dimension than the respawn, or the items have despawned (5 minutes). It SHALL skip when more than `maxWaterDepth` (8) water is above the spot, the spot is farther than `maxDistance` (400), the walk (straight distance x 1.3 at 4.3 blocks/s) plus `marginSeconds` (30) is longer than the time left, or an online player killed it (`avoidPlayerKillers`). The expected mobs SHALL be the ones seen within 12 blocks of the spot when the bot is within 48 blocks of it, else the report's hostiles plus the killer, without a creeper that exploded; they SHALL count as threat points (zombie 1, skeleton 1.5, witch 2, ...; warden, ravager, evoker, elder guardian, wither and dragon never), undead quartered by day under open sky, plus 1 at night. Above `freeThreat` (1) points the gear score SHALL be at least 15 + `gearPerThreat` (12) per point; at night with a gear score under `nightGear` (40) only spots within `nightMaxDistance` (48) qualify. Failing either it SHALL wait (re-checking within 15 s) while the time left allows the trip later, else skip.

#### Scenario: Killed by three skeletons
- **WHEN** the bot was shot dead in a cave with 3 skeletons around and respawns 100 blocks away with no gear
- **THEN** the decision is wait ("3 skeleton by my things and my gear scores 15 (69 needed)"), and go when it wears iron with a shield and a sword

#### Scenario: Lava
- **WHEN** the bot burned to death in lava
- **THEN** the decision is skip, "my things burned in lava", and `recover_items force=true` refuses too

### Requirement: Recovery trip
`recover_items` SHALL walk to the death spot in legs, give up when the items would despawn before it arrives, at `give_up_health` (8) health or less, or when the mobs within 12 blocks of the spot (checked from 24 blocks out) need more gear than it has; pick up drops within `radius` (10) of the spot; wear the best armour and take the best weapon; and report "got back N of M items: ..." with tools and armour first, counting only items that were lost (capped at the lost count) and naming what is still missing. Without `force` it SHALL refuse when the decision is not go; with `force` only drops that are gone are refused. A completed trip SHALL mark the death handled; an aborted one SHALL NOT.

#### Scenario: Partial recovery
- **WHEN** the bot lost a stone sword, 25 cobblestone, 5 bread and an iron pickaxe and picks up the sword, 20 cobblestone, 2 bread and 9 dirt
- **THEN** it says "got back 23 of 32 items: stone sword, 20 cobblestone, 2 bread; still missing iron pickaxe, 5 cobblestone, 3 bread"

### Requirement: recover_drops behaviour
The `recover_drops` behaviour (survival, priority behavior) SHALL score 72 (above chores, food and stay_safe's night trip home, below water, mobs and low health) when the decision for an unhandled death is go, once the bot is alive and the death report is in (or 6 s passed). It SHALL run `recover_items`, tell the owner the result (whisper when online), and go home when a home is set in the same dimension. A skip SHALL mark the death handled and tell the owner why when items were lost. Each death SHALL be recovered once; a trip cut short by a preemption MAY start again, at most 3 trips per death. Options: maxDistance, marginSeconds, giveUpHealth, nightMaxDistance, nightGear, freeThreat, gearPerThreat, avoidPlayerKillers, maxWaterDepth, radius, goHome, announce. Pax arms it.

#### Scenario: Fall death near home
- **WHEN** Pax falls to its death 80 blocks from its bed by day carrying 31 items and respawns at the bed
- **THEN** it walks back right after the respawn, picks the items up, puts its armour on, says what came back and walks home
