# Repair materials

## Why
Pax's fortress stood at 629 of 648 with a hole in the floor its owner reported. The repair asked
for 9 cobblestone; gathering strip-mined next to home, which the base keep-out sends out past the
walls onto a frozen lake, turned at water four times and gave up with 0 cobblestone after 21 s.
Its chests held 666 cobblestone and its own staircase mine was 16 blocks away: the LLM's
`build gather=true` never looked in the chests, and nothing knew to try the mine or stone further
out. The floor stage also reported 154/154: a floor cell with a foreign block on top was left
alone even when the cell itself was empty, and base safety only looks at dark cavities, not at
holes in the floor open to the sky.

## What changes
- Core (`src/core/materialSources.ts`): `materials:` settings (sources, retryMinutes, mineMinutes,
  farDistance, farTries) with a zod schema, defaults and live toggles.
- Minecraft: a pure planner (`materialSourcePlan.ts`) that walks the ordered sources (chests,
  substitutes the blueprint roles accept, craft, nearby, mine, far) for what is short, says why
  each one is used or skipped, and remembers per source and item what gave nothing; the glue
  (`materialSources.ts`) runs one step at a time and re-plans. Builds with gather, base project
  sessions and `gather_materials` all use it. `dig_mine` can collect cobblestone (`collect`).
  The run and the plan show in `projects`, `plan_base` and the status notes.
- Site prep takes dirt for dips under the floor from its chests.
- Survey: an empty floor cell is always counted, whatever is on top.
- Base safety: holes in the floor surface inside the walls are found and filled (dirt in the farm
  plot), `baseSafety.floorHoles` (default on).
