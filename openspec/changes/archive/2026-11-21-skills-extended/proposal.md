# Extended skills

## Why

The standard skills cover moving, fighting, eating and collecting single blocks. NPC and LLM
brains need more to do anything useful on a survival server: make tools, store loot, keep a
farm going, get wood and put blocks down.

## What changes

- New skills in `src/skills/`: `crafting` (craft, smelt), `containers` (deposit, withdraw,
  list_container), `farming` (harvest, plant, till), `woodcutting` (chop_tree), `building`
  (place_block) and `pickup` (pickup_items).
- Shared helpers in `src/skills/world.ts` (placing against a neighbour face, walking into reach,
  finding a free spot for a table/furnace).
- `extendedSkills()` bundle exported from `src/skills/index.ts`. `standardSkills()` is unchanged.
- `scripts/skill-test.ts` runs actions against the live server for manual checks.
- `docs/skills.md` lists every skill and action.

## Non-goals

- No recursive crafting (crafting the ingredients of an ingredient), except putting down a
  crafting table made from planks.
- No core changes.
