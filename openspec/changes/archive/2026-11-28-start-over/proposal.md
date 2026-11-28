## Why
Pax's fortress at 560 67 -43 sits in a snowy biome: no grass for seeds, frozen shores, animals 285+ blocks away, an empty pantry and 16 deaths in a night. The owner asked it to "just start over and get all its chest items that are most precious and go". Moving the base isn't worth it; starting again somewhere better is.

## What Changes
- New action `start_over` (owner-triggered; also `settings.startOver.go` once on start, remembered in storage) with `cancel` and `status`.
- New behaviour `start_over` (armed by default on the companion) that runs the steps from a stored state: pack, leave, walk legs by day, dig in at night, look, settle. Resumes after restarts and deaths.
- Pure planner `src/skills/startOverPlan.ts`: settings with per-key fallback, the pack ranking (value table, take/leave lists, one of each gear slot only when better), the heading away from spawn and avoid points with 45/90 degree detours, the site verdict (grass, trees, water, animals; not snowy, protected or built on), the state machine and the storage clean-up of the old base.
- Leaving drops home and everything anchored to the old base (base-project anchor and progress, farms, site records, places/containers/food spots/beds near it, ring searches); the old base stays as place `old_base`. `home.away` keeps the NPC controller from putting home where it stands while travelling.
- Settling sets home, places the bed and a chest, stores ores and ingots; the usual behaviours build fresh around the new home.
- Live toggles `startOver.*`, journal type `start_over`, docs page `guide/start-over`.
