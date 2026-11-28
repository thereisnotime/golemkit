## Why
Pax kept going for items lying in water: the air reflex stopped pickup_items ("out of air ... swam up"), collect_drops picked the same drops again a few seconds later, ten times in two minutes. Nothing remembered that those drops cost it its air.

## What Changes
- Every pickup cut short by running out of air (the air reflex took over with the head under water, or travel gave up with "kept running out of air") counts as an air break against the drop it was going for.
- After `pickup.maxAirBreaks` (default 2) the drop, and any drop within `pickup.matchRadius` (default 2) blocks of it, counts as unreachable for `pickup.unreachableMinutes` (default 10). One log line when it gives up.
- pickup_items (and so pickupNearby, used by mining, woodcutting and recover_items), the collect_drops score and recover_items skip those drops. The decision lives in a pure planner, `src/skills/pickupPlan.ts`.
- New live toggles `pickup.maxAirBreaks`, `pickup.unreachableMinutes`, `pickup.matchRadius`; `settings.pickup` is checked for unknown keys.
