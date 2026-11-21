## Why

Bots could build, but what they built looked bad: the default house was a 5x5 plank box with a
flat plank roof and open window holes. Blueprints could only say *which* block goes where, never
*how* it is placed, so stairs, slabs, logs, doors, trapdoors, torches, ladders and beds came out
in whatever orientation the bot happened to be looking. Materials stopped at planks and doors.

## What Changes

- A placement planner that turns a wanted block state (stair facing and half, slab half, log axis,
  door facing and hinge, trapdoor facing/half/open, wall torch and ladder side, bed facing, chest
  and furnace facing) into a reference block, face, cursor and look direction, places it, reads it
  back and retries or fixes once.
- Blueprint format extensions, backwards compatible: palette states (`{ role, state }`,
  `role[k=v]`, plain `minecraft:block[k=v]`), `^ v < >` stair shorthand, states that rotate with
  the blueprint, wood themes (`wood: true` roles), fallbacks (fences for missing glass),
  furnishing roles, passive halves (bed head), an optional `meta:` block, and loading from a list
  of directories.
- New blueprints: `small_house` (the default "build a house"), `cottage`, `cabin`, `watchtower`;
  `hut` and `shelter` stay for emergencies. A text preview (`build_plan preview=true`,
  `scripts/blueprint-preview.ts`).
- `gather_materials` plans and crafts stairs, slabs, fences, trapdoors, doors, ladders, chests,
  crafting tables, furnaces, beds and glass panes; torches from coal or charcoal; glass from sand;
  wool from sheep; cobblestone with a pickaxe. Optional things degrade gracefully and are reported.
- Site preparation: fill dips, dig bumps and plants, door towards the player or an open side, an
  optional dirt path.
- A quality check after every build: every planned block and state is verified, mismatches are
  fixed once, and the result says "built 182/186 ... skipped: bed (no wool)".

## Impact

- Code: `src/skills/blockstate.ts` (new, pure), `src/skills/placement.ts` (new),
  `src/skills/blueprint.ts`, `src/skills/construction.ts`, `src/skills/materials.ts`,
  `src/skills/crafting.ts` (`smeltItem` extracted), `src/skills/combat.ts` (`inPen` exported).
  No core changes.
- Blueprints: four new files; the old ones are unchanged and still load.
- LLM-facing: `build`/`build_plan`/`gather_materials` descriptions and Pax's build-house skill now
  point at `small_house`.
