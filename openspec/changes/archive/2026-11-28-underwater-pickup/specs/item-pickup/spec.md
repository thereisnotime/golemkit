## ADDED Requirements

### Requirement: Give up on drops it can't reach without air
The bot SHALL count, per dropped item (by entity id, or within `pickup.matchRadius` blocks of where it lay), how many times going for it was cut short by running out of air. After `pickup.maxAirBreaks` such air breaks (default 2; 0 = never give up) it SHALL treat the drop and the drops lying with it as unreachable for `pickup.unreachableMinutes` (default 10), skip them in pickup_items, in the collect_drops "anything to collect" check and in recover_items, and log one line when it gives up.

#### Scenario: items on the bottom of a lake
- **WHEN** the air reflex stops pickup_items twice while the bot swims down to the same drops
- **THEN** the bot logs that it gives up on them and collect_drops no longer scores those drops

#### Scenario: a drop it can reach
- **WHEN** a drop lies on dry land more than matchRadius blocks from the given-up ones
- **THEN** pickup_items still goes for it

#### Scenario: never give up
- **WHEN** pickup.maxAirBreaks is 0
- **THEN** no drop is ever skipped for air breaks

### Requirement: Forget air breaks after a while
Air breaks and given-up drops older than `pickup.unreachableMinutes` SHALL be forgotten, so drops there count as reachable again.

#### Scenario: given up long ago
- **WHEN** unreachableMinutes have passed since the last air break at a spot
- **THEN** the drops there count as reachable again
