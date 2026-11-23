# Trip preparation and turn-back budget

## Why
Two of Pax's deaths on 2026-11-23 were starving trips: keep_fed scouted 120 and then 250 blocks out for food, the food bar went 12 -> 0 in six minutes, and Pax died out there (shot, drowned). It left without food from its pantry, and nothing told it to come back while it still had the food and daylight for the walk home.

## What changes
- A game-agnostic trip planner (`src/core/trip.ts`): `settings.trips`, the pre-trip check (top up food to `trips.food` items, a weapon, `trips.minHealth`), the turn-back budget (half the food it left with, a food-bar floor with nothing to eat, daylight about the walk home plus a margin, a thunderstorm), and a trip context per game client so travel and scouting loops see the active trip.
- Minecraft wiring (`src/skills/trip.ts`): food and daylight sampling, the pantry top-up from own and configured chests (`takeFoodFromOwnChests`), holding the best weapon, the `prepare_trip` action, the budget timer, `actionTrip` for actions that leave home themselves; `travel()` stops mid-leg with `TripTurnBackError` once a trip turns back.
- Behaviours (`behaviors/trip.ts` `tripRun`): keep_fed scouting, food trips, food spots and far farm visits, farm_setup far farm visits, keep_spawn_bed sheep scouting. Actions: chop_tree rings past 64 blocks, upgrade_tools going for ore (also tops up once when safe mining says not ready for food). Owner orders are left alone unless `trips.ownerOrders`.
- After a turn-back the bot walks home and reports `turned back: <why> (<purpose>)`; keep_fed doesn't record the ring as empty and starts no other trip that run.
- `trips.*` live toggles, profile key check, Pax's profile sets them; docs (behaviors, progression, live-config).
