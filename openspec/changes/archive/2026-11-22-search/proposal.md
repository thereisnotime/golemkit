# Finding and fetching things

## Why

Owners ask bots for things all the time: "where's iron?", "find me sheep", "bring me 16
planks", "get my stuff, I died". Without the LLM a bot could only gather what was in reach or
scout for food. These requests should work as plain actions that plain-language commands (and
the LLM) can call by name.

## What changes

- New `search` skill (`src/skills/search.ts`, in `extendedSkills()`) with three long-running actions:
  - `find_target`: resolves a word to blocks, ore families, mobs, structures (village, nether
    portal, chest), biomes or modded names; looks at what is loaded, remembered spots, then a
    surface spiral scout with find_food's safety rules, then (ores) the safe strip mine. Remembers
    the spot as `found:<target>`, records a journal event, reports coordinates, distance and
    direction from the owner, and comes back (or stays with `go`). `bring` also fetches `count`.
  - `bring_item`: inventory, own chests, crafting, gathering, then a search for the source;
    walks to the player, tosses the items and reports how many were really handed over.
  - `fetch_drops`: goes to where a player died (death message plus where it last saw them, or
    given coordinates) when it can get there before the items despawn, and brings them back.
- Pure decisions in `src/skills/searchPlan.ts`: target resolution, search phases, village and
  portal recognition, find description, gather sources and bring order, own-chest rules, toss
  accounting, despawn window, progress rate limit.
- Small exports for reuse: `food.ts` scouting helpers, `containers.ts` withdraw, `mods.ts`
  modded registry names.
- `scripts/search-test.ts` live test; `docs/guide/search.md`.
