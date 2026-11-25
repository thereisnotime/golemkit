# Design

## Layers

```
NpcController.tick
  blackboard, hooks, back-off            (unchanged)
  score regular behaviours               (unchanged)
  NeedsLayer.plan(ctx, scores)           urgencies, boosts, fallback choice
    boosts: +boost * urgency on behaviours serving an urgent need (capped below urgentScore)
    fallback: only when no regular score is above the idle band (15)
      1. search for the most urgent need whose servers all score 0 (cooldown, per-day cap)
      2. else the idle mode's chore (pickChore)
  score layer behaviours (need:<name>, idle:<chore>) from the plan
  decide / start / switch                (unchanged; layer behaviours get stats, cooldowns, back-off)
  NeedsLayer.tick: site checks (throttled), re-checks of bad sites
```

Layer behaviours are ordinary `Behavior`s, so failure back-off, flip back-off, help desk,
yielding to players and the action lock all apply to them without new code.

## Game-agnostic parts

- `src/core/needs.ts`: settings schemas (zod) and resolvers for `needs`, `idle`, `sites`.
- `src/core/sites.ts`: `noteSiteCheck` (pure transition), `recheckDue`, `SiteBook` (records
  in `agent.storage` under `sites`, journal `site` events, owner whispers).
- `src/brains/npc/needs.ts`: `NeedsProvider` (what an adapter supplies: needs, chores, site
  probes, failure-to-site mapping, clock), `planNeeds` (pure), `NeedsLayer`.
- `src/brains/npc/idle.ts`: modes and `pickChore` (pure).

## Minecraft parts

- `src/adapters/minecraft-java/needs/`: the provider. Urgencies read the bot (food bar, health,
  danger, armour and tool tiers, wood and pantry stock, night). Gear's search is
  `find_target iron exposed=true` within the trip budget, `upgrade_tools` at the find, `go_home`.
- Chores wrap existing actions (look_around, wander, go_home, deposit via deposit_when_full's
  body, chop_tree, gather_seeds, tend_farm, craft, light_up, find_target).
- Site probes: farm (cells water/ice, farmland and tillable ground: `farmSiteVerdict`), spawn bed
  (gone), own chests (gone), home (in water or lava, buried). A bad farm is removed from the farm
  list (kept in the site record); `start_farm` skips candidates within reach of a bad farm, water
  in cold biomes (it freezes), roofed or dark cells and sites near lava.
- `find_target` gets `exposed`: ores count only with an open face.

## Defaults

Needs are on; a need is active when one of its serving behaviours is in the set or it is
enabled explicitly. Search radius 160, 6 minutes, 30 minutes between searches per need, 6 a day,
by day only. Idle mode `idle`, radius 24. Sites: 3 checks in a row, checked at most every 5
minutes per site, re-checked every 6 hours, replace on, tell owners on.
