# Needs, site health, go looking and idle modes

## Why

Pax goes idle whenever its world changes. Its farm at 561 62 -20 became part of a frozen lake:
the farm planner finds 0 cells of work, forever, while 35 seeds sit in the pantry. It has no
iron armour because keep_tools_upgraded only uses ore it can already see. With nothing to do it
stands there, and the controller logs an idle report every 120 s. Each earlier fix was a
hand-written Minecraft patch for one case. This change adds one framework-level mechanism.

## What changes

- **Needs** (game-agnostic, `src/brains/npc/needs.ts`): standing drives the NPC controller
  satisfies: safety, food, gear, supplies, rest. The game adapter supplies each need's urgency
  (0..1), the behaviours that serve it and, optionally, a way to go looking for it. While a need
  is urgent, the behaviours serving it score higher; when nothing scores above the idle band, the
  most urgent need with no visible way to be met starts a bounded search.
- **Site health** (`src/core/sites.ts`): places the bot depends on (farm, bed, chests, home) are
  checked when the bot is near them. Flooded or gone marks a site bad at once; unreachable or "no
  work" marks it bad after `sites.failures` checks in a row. Bad sites are persisted with reason
  and time, the adapter replaces them or the owners are told, and they are re-checked every
  `sites.recheckHours`. The Minecraft adapter checks farms for water and ice, beds, its own
  chests and home; a bad farm is dropped so a new one starts near home, on dry, lit, safe ground
  away from the bad site and cold biomes, outside protected areas and spawn clearance.
- **Go looking**: a need with no visible way to be met (no iron ore in sight for armour) runs
  one bounded search: `find_target` within `needs.search.radius` blocks and `minutes`, by day,
  inside a trip budget, then the need's action at the find (upgrade_tools), then home. What it
  finds is remembered (`found:iron`) and checked first next time. Safe-mining rules, the air
  reflex, protected areas and danger zones apply as for any search.
- **Idle modes**: what the bot does when no need is urgent and nothing scores: `off`,
  `passive` (look around), `idle` (near home: look around, stroll, come home, wait by the bed at
  night), `active` (chores: tidy storage, top up wood and seeds, extend the farm, craft spares,
  light dark spots, scout nearby), `explore` (active plus longer scouting trips that come home).
  Per-chore enable/disable, radius, time-of-day window and cooldown. Default `idle`; Pax `active`.
- **Settings**: profile keys `needs:`, `idle:`, `sites:` (zod, in `src/core/profile.ts`), live
  toggles under `needs.*`, `idle.*`, `sites.*`.
- **Controller snapshot**: `controller.snapshot()` returns the running behaviour, its goal, the
  most urgent need, why it was chosen, the idle mode and chore, and the time of the last progress,
  for the status view.

## Other proposals

- **daily-routine**: absorbed. Its routine (farm round, deposit, re-craft tools, gather what the
  base is short of, light dark spots, sleep at night) is the `active` idle mode's chore list, with
  per-chore time-of-day windows instead of a separate routine format. Its "NPC mode uses the
  routine" part is left: NPC mode still arms its own set, and the idle mode applies on top of it
  whether the LLM is up or not. Its Status section notes this.
- **job-queue**: left as is. Owner-queued jobs with end conditions are orders, not drives; a job
  queue would run above the needs layer (player-request priority) and the idle mode fills the gaps
  between jobs.

## Non-goals

- No planner over goals (GOAP/HTN); needs pick between existing behaviours and one search.
- No new mining strategy: the search walks the surface; going deep stays with safe mining.
- No second game; the interfaces are game-agnostic and only the Minecraft adapter fills them.

## Status

Implemented on branch goals-idle.
