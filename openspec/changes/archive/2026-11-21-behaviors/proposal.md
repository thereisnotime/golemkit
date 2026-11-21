## Why

LLM bots had nothing running between turns. Pax sat at 6/20 health with no food and died
twice: no turn told it to get food, and every multi-turn job stalled. Owners also had no way
to switch standing routines on and off per bot without editing a variant.

## What Changes

- A behaviour registry: named definitions with a zod options schema, a description written
  for LLMs, category, required actions, terrain needs and a default priority level.
- A `behaviorsBrain()` that keeps an armed set and runs it through the existing
  `NpcController`, with per-behaviour priority and per-level back-off.
- Arming from variant defaults, the profile `behaviors:` block, chat, LLM tool calls, hooks
  and self-improver programs, through `behavior_list/status/arm/disarm/configure/reset`.
  Runtime changes persist in `agent.storage`.
- A library of 16 behaviours (keep_fed, stay_safe, follow_owner, guard_area, guard_owner,
  collect_drops, deposit_when_full, sleep_at_night, return_home, wander, chop_wood_loop,
  farm_loop, light_area, avoid_mobs, greet_players, idle_look).
- New actions: `hunt` (combat), `pillar` (survival), internal `look_around`; `flee` takes an
  `entityId`.
- Core: `PRIORITY.behavior = 35`; profile schema gets `behaviors:`.
- Pax/companion arm keep_fed and stay_safe by default.
