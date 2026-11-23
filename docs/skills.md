---
scope: mixed
scopeNote: "Most skills are Minecraft; journal and config are game-agnostic."
---

# Skills

Every skill and action that ships with golemkit. Parameters, defaults and flags for each
action are in the generated [action reference](./reference/actions.md); this page says what
each one is for and how it behaves.

Two bundles live in `src/skills/index.ts`:

- `standardSkills()`: status, config, movement, combat, survival, inventory, gather,
  [journal](/guide/journal), bodyguard.
- `extendedSkills()`: crafting, containers, farming, food, search, woodcutting, building, construction,
  roads, blueprint library, materials, progression, pickup, worldedit.

`navigation()`, `modsSkill()` and `config()` are exported on their own (the villager bot uses
`navigation()`).

```ts
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
export default defineVariant({ name: 'farmer', skills: [...standardSkills(), ...extendedSkills()], brains: [...] })
```

Non-exclusive actions (marked *ne*) run alongside whatever holds the body. Actions marked
*dig* need digging enabled (`canDig`, `--dig`, `MC_CAN_DIG=true`) and fail politely otherwise.

## Standard and navigation

### status
| action | |
|---|---|
| `pos` *ne* | Report position and dimension. |
| `hp` *ne* | Health, food and the current action. |
| `stop` *ne* | Stop whatever the bot is doing. |
| `say` *ne* | Say something in public chat. |

### movement

- `goto` handles any distance: long trips go in legs through loaded chunks and run in the background ([details](concepts/world#long-distance-travel)).

| action | |
|---|---|
| `come` | Walk to a player (default: whoever asked). |
| `follow` | Follow a player until stopped (long-running). |
| `goto` | Walk to coordinates; omit y for the surface. |
| `goto_player` | Walk to where a player is now, once. |
| `look_at` *ne* | Turn to look at a player. |
| `jump` *ne* | Jump once. |
| `look_around` *ne* | Glance at a nearby player now and then, otherwise a random direction (idle fidget, internal). |

### combat

- `retreat` (internal): back off from hostiles, used by [reflexes](/concepts/world#reflexes) at low health. [Flying mobs](/concepts/world#hostile-mobs) are fought in place, not chased ([details](concepts/world#hostile-mobs)).

| action | |
|---|---|
| `attack` | Fight the nearest hostile mob, or an entity by id. |
| `guard` | Protect a player from hostile mobs until stopped (long-running). |
| `defend` | Fight back at the closest hostile (internal, used by reflexes). |
| `hunt` | Hunt passive animals for food and pick up the drops. Never pets, named, tamed, leashed or baby animals, villagers or players, never in protected areas; fenced animals only with `pens=true`. `keepAtLeast` spares the last N adults of each kind. With `reach` (default on) it bridges, pillars or digs to an animal it can't walk to, never in protected areas or danger zones. |
| `gear_up` *ne* | Wear the best armour in the inventory and put a totem of undying or a shield in the offhand (the reflexes run it when there is an upgrade, `combat.autoArmor`). |
| `ranged_defense` | Answer mobs that shoot at the bot: shoot back, shield up and close in, take cover (or build some) and eat there, or back out of range, by health, gear and numbers (internal, used by reflexes and `stay_safe`). |
| `water_bucket` | Land a long fall in water placed just before the ground, or put out fire, then scoop the water back up (internal, `combat.waterClutch`). |
| `defend_player` | Fight back against a player who attacked the bot or the player it guards, only with `combat.pvp defend`; never owners or `combat.friends` (internal). |

The fight loop uses skilled-player techniques (crits, W-tap, sweeps, shield timing, totem,
golden apples, chokepoints, enderman gaze), each behind a `combat.*` toggle you can change live
with `config_set`; see [Skilled-player techniques](/concepts/world#skilled-player-techniques),
[PvP: defend only](/concepts/world#pvp-defend-only) and the
[combat research](/concepts/combat-research) page. The decisions are pure and unit-tested
(`tactics.ts`, `techniques.ts`, `pvp.ts`, `ranged-plan.ts`); `fight.ts`, `ranged.ts`, `clutch.ts`
and `defense.ts` apply them.

### bodyguard
| action | |
|---|---|
| `protect` | Stay with a player as a bodyguard until stopped: keep between them and the nearest danger, kill what threatens them, block arrows with a shield, toss them food when they look hurt (long-running). |
| `feed_player` | Walk up to a player and toss them food, keeping some for itself. |

See [Bodyguard](/guide/behaviors#bodyguard).

### survival
| action | |
|---|---|
| `eat` | Eat the best food in the inventory. |
| `sleep` | Sleep in a bed within 16 blocks. |
| `wake` | Get out of bed. |
| `pillar` | Emergency escape: jump and place blocks underneath, out of reach of mobs. |
| `climb_out` | Get out of a pit, shaft or cave straight up to open sky; without blocks it carves steps into the wall. |
| `bunker` *dig* | Hide from phantoms and other mobs: dig down 3 blocks, seal the hole, wait for morning or until no hostiles are near, then climb out. |

### inventory
| action | |
|---|---|
| `inventory` *ne* | List what the bot carries. |
| `drop` | Throw items towards the player, or `all`. |
| `equip` | Hold an item in the main hand. |

### gather
| action | |
|---|---|
| `collect` *dig* | Mine N blocks of one type nearby and pick up the drops. Equips the best tool; for stone and ores it crafts a pickaxe of the needed tier first when the inventory allows. Skips blocks it can't reach and protected areas. |

### config
Feature toggles changed in game without a restart; see [Live config](/guide/live-config).

| action | |
|---|---|
| `config_list` *ne* | Settings that can be changed in game, with current values. |
| `config_get` *ne* | One setting, what it does and whether it was changed in game. |
| `config_set` *ne* | Change a setting live (owners only), e.g. `config_set combat.pvp defend`. |
| `config_reset` *ne* | Back to the profile values, one key or all (owners only). |

### journal
See [Event journal](./guide/journal.md).

| action | |
|---|---|
| `recall_events` *ne* | Recent journal events, filtered by type, time, place, player or text. |
| `last_death` *ne* | Where and when it last died, the cause, what it lost, whether the drops may still be there. |
| `history` *ne* | Summary of today, yesterday, a date or an hour range. |
| `goto_death` | Walk back to the last death spot and pick up the drops. |

### navigation
| action | |
|---|---|
| `wander` | Short walk to a random spot near home (or a given center, or where the bot stands). |
| `set_home` *ne* | Remember a home position (default: here). |
| `go_home` | Walk back home. |
| `remember_place` *ne* | Remember a named place to walk back to later. |
| `forget_place` *ne* | Forget a named place. |
| `places` *ne* | List home and remembered places. |
| `goto_place` | Walk to a remembered place. |
| `flee` | Run from the nearest hostile mob until it is far enough away. |

## Extended

### crafting
| action | |
|---|---|
| `craft` | Craft N of an item from the inventory. Uses a crafting table within 16 blocks, or places one (from the inventory, or crafted from planks) and says where. Crafts in chunks and switches recipe [variants](/concepts/variants-profiles) (plank types) as materials run out. |
| `smelt` | Smelt N items in a furnace within 32 blocks (or one placed from the inventory). Picks fuel (coal, charcoal, planks, logs, sticks; never the input), polls the output once a second and takes results until done, the furnace stops burning, or ~10 s per item passes. |

Recipes come from minecraft-data, not the server (its recipe packet carries modded items and
is skipped), so modded recipes aren't craftable. `craft` only makes the item itself, not its
ingredients; `gather_materials` does the whole chain for wooden things.

### containers
| action | |
|---|---|
| `deposit` | Store an item, or `all`, in the nearest chest/barrel/shulker box or the one at x y z. `all` keeps tools, armour, food and anything in `keep`. Reports partial deposits when the container fills up. |
| `withdraw` | Take N of an item (or `all`) out of a container. Stops when the inventory is full. |
| `list_container` *ne* | What's inside. Opens it only when it is within reach and the bot is idle; otherwise answers from what the bot saw last time it opened it (in memory). |

Observe hook: `containersNearby` (within 16 blocks).

### farming
| action | |
|---|---|
| `harvest` | Break ripe wheat, carrots, potatoes and beetroot in a radius (ripeness from the block's `age`), replant with the matching seed, pick up drops, then re-seed any farmland it left bare. `x y z` limits it to one field (e.g. `farm:1`). |
| `plant` | Plant seeds (`wheat_seeds`, `carrot`, `potato`, `beetroot_seeds`) on empty farmland (around the bot, or `x y z`). |
| `till` *dig* | Hoe dirt/grass into farmland at x y z, or the nearest spots within 4 blocks of water. |

Harvest and plant don't change terrain, so they work with digging off. Observe hook:
`ripeCropsNearby`.

### food

Food self-sufficiency, used by [`keep_fed`](/guide/behaviors#keep-fed) and [`farm_setup`](/guide/behaviors#farm-setup).
What it finds is remembered in `agent.storage` (`foodSpots`, `farms`), as named places
(`food:animals`, `food:village_farm`, `food:water`, `farm:<n>`) and in the [journal](/guide/journal)
(`food_spot`, `farm_started`). The planning is pure and unit-tested: `foodPlan.ts` (scout
rings, farm sites, plot layout, which food spots are worth a trip), `farmPlan.ts` (what to plant,
re-till and grow) and `reachPlan.ts` (when `hunt` may bridge, pillar or dig). The order
`keep_fed` climbs through these is the [food ladder](/guide/behaviors#food-keep-fed-the-food-ladder-and-farm-setup).

| action | |
|---|---|
| `find_food` | Scout for animals or a village farm beyond what is in sight: known spots first, then an expanding spiral around home out to `radius` (default 200; `minRadius` skips rings an earlier search covered), by day, skipping water, lava and protected areas, giving up when stuck, at night, at low health or after `maxMinutes` (default 8). Remembers what it finds; doesn't hunt. |
| `start_farm` *dig* | Start a farm of its own: first a site, shore water near home or a place with at least 8 grass/dirt cells at the water's height (or under a one-block bank it digs off), outside protected areas, the spawn and away from builds or fields (or water poured from a bucket); then seeds from breaking grass (or carrots, potatoes, beetroot seeds), a hoe (crafted, chopping logs first if needed), a plot of up to 9x9 tilled and planted around the water, a fence and torches if it has the materials. Saved as `farm:<n>`. |
| `tend_farm` | Look after its own farm: put the water back, plant bare farmland, till trampled dirt again, and grow the plot a ring at a time towards `size` (up to 9x9) with the seeds beyond `seedReserve`. Tilling needs digging. |
| `gather_seeds` *dig* | Break grass and ferns patch by patch out to `radius` until it has `count` seeds, the time is up or the grass runs out. Skips protected areas and the world spawn. |
| `forage` | Stopgap food: ripe sweet berries, kelp at the shore, and with `apples=true` oak leaves for apples. Never on protected land. |
| `breed` | Feed two adults of a kind (cows/sheep: wheat, pigs: carrots/potatoes/beetroot, chickens: seeds, rabbits: carrots), leading them to its farm first. Same animal filter as `hunt`; keeps seeds for replanting and stops at `maxHerd`. |

Never taken from other players: crops count only on the bot's own farm or a village farm
(villagers within 24 blocks), and animals inside fences only on its own farm. Observe hook:
`farms`, `foodSpots`.

### search

Finding and fetching for players without the LLM; see [Finding and fetching](/guide/search). The
decisions are pure and unit-tested (`src/skills/searchPlan.ts`). Finds are remembered as named
places `found:<target>` and as `found` journal events.

| action | |
|---|---|
| `find_target` | Find a block family (iron, diamonds, logs, sand, water), a mob, a structure (village, nether portal, chest), a biome or a modded name: what is loaded first, remembered spots, then a surface spiral scout by day (and the strip mine for ores with `prospect`). Reports coordinates, distance and direction from the owner, and comes back (or stays with `go`). `bring` fetches `count` of it and hands it over. |
| `bring_item` | Get an item from the inventory, its own chests (placed by it or in `settings.storage.chests`), crafting, gathering or a search for its source, then walk to the player, toss it and say how many they picked up. |
| `fetch_drops` | Go to where a player died and bring their items back, when it can get there before they despawn. |

Observe hook: `found`.

### woodcutting
| action | |
|---|---|
| `chop_tree` *dig* | Fell the nearest natural tree of any wood type: cut its logs bottom-up with the best axe, skip logs out of reach, pick up drops and plant a matching sapling on the stump's soil. Crafts a wooden axe first when there is none and the inventory has the wood (`make_axe`). |

A "natural tree" is a connected group of logs with at least three non-persistent leaves
attached. Player-placed leaves are persistent, so log walls, cabins and log piles are left
alone. Very tall trees (big spruce, jungle) leave their upper logs standing; the result says
how many were out of reach.

### building

- `break_block x y z [force]`: break one block with the best tool; refuses storage blocks unless `force`; fails clearly (and teaches the bot the zone) in [protected areas](/concepts/world#protected-areas).

| action | |
|---|---|
| `place_block` | Place a block from the inventory at x y z against any solid neighbour (never a chest, door or other block that would open/toggle, never a modded block). |
| `break_block` *dig* | Break the block at x y z with the best tool, crafting a pickaxe first for stone and ores when it can. Refuses containers unless `force`. |

### construction
| action | |
|---|---|
| `build` | Build a whole structure from a [blueprint](/guide/goals-and-building#blueprint-format) (`small_house` is the default house; `cottage`, `cabin`, `watchtower`, `hut`, `shelter`, `wall_segment`, `platform`, `tower`): picks a flat, natural site near whoever asked, outside protected areas and spawn, fills dips and digs bumps, faces the door to the player or an open side, refuses if the footprint has player-made blocks, places every block in the state the blueprint asks for (stair facing and half, log axis, door hinge, wall torches...) with the [placement planner](/guide/goals-and-building#the-placement-planner), checks every block afterwards and fixes mistakes once, skips blocks already right (re-running resumes on the same site) and reports built/total and what was skipped. `gather=true` gathers missing materials first; `theme` picks the wood. Long-running. |
| `build_plan` *ne* | Without a template, lists the blueprints; with one, where it would go, which wood it would use and its materials vs the inventory. `preview=true` adds a text drawing (top view and every layer). |

Blueprints are YAML in `blueprints/`. Observe hook: `build` (the structure in progress). See
[Goals and building](./guide/goals-and-building.md) for the format. Finished structures are
recorded (`build.placements`) so roads can find their doors.

### roads
| action | |
|---|---|
| `build_road` *dig* | Plan and build a road with stairs from the bot (or a place, player, coordinates) to a place: straight flights, stairs only on straight stretches facing up, flat landings at turns, switchbacks on steep ground, base filled to the ground, head-room cut, wall railings on drops of 2 or more, never through buildings, trees or protected areas, T-junctions onto existing roads. `dry_run=true` plans only (length, stairs, landings, cut/fill, materials); `redo=<id>` builds a removed road again. Survival gathers stone bricks first; creative by hand or with `/fill`. Long-running. |
| `connect_buildings` *dig* | Join buildings (the ones it built, doors among its own blocks, doors nearby, or given doors) cheapest roads first, later roads meeting earlier ones at T-junctions. Long-running. |
| `remove_road` | Take out a road it built (only blocks still its own), creative puts the dug ground back. Long-running. |
| `road_list` *ne* | The roads it built, with ids. |

See [Roads and stairs](./guide/roads.md).

### blueprint library
| action | |
|---|---|
| `blueprint_list` *ne* | The blueprints in the shipped, user and learned libraries, with size, tags and materials. |
| `blueprint_search` *ne* | Search by text, tags, material and size, best match first. |
| `blueprint_show` *ne* | One blueprint: library info, a text drawing and its materials vs the inventory. |
| `blueprint_pick` *ne* | Pick a blueprint for a request, following the `building` policy (library, creative or ask). |
| `blueprint_import` *ne* | Import a schematic (.schem, .schematic, .litematic, .nbt, .bp) into the learned library (owners only). |
| `blueprint_capture` *ne* | Save a build in the world as a learned blueprint (owners only). |
| `blueprint_design` *ne* | Validate and save a blueprint written as YAML or JSON. |
| `blueprint_delete`, `blueprint_rename` *ne* | Manage learned blueprints (owners only). |

See [Blueprints](./guide/blueprints.md).

### materials
| action | |
|---|---|
| `gather_materials` *dig* | Get everything for a shopping list (`{"planks": 80, "door": 1}`, generic names mean any wood or colour) or a blueprint (`template=small_house`): fells trees (crafting a wooden axe as soon as it has wood), crafts planks, sticks, stairs, slabs, fences, doors, trapdoors, ladders, tables, chests, furnaces, beds and tools, mines cobblestone, andesite, diorite, granite and tuff with a pickaxe, makes the stone family (cobblestone, stone and stone brick slabs, stairs and walls, stone bricks, smooth stone, smelting cobblestone into stone on the way), and tries for torches (coal or charcoal), glass panes (sand smelted) and a bed (wool from sheep). Reports what is still missing and what was skipped, and why. Long-running. |

### worldedit
For servers that run [WorldEdit](/guide/worldedit) (mod, plugin or FAWE) and let the bot use it; see
[WorldEdit](./guide/worldedit.md). All owners only, with a block limit (`worldedit.maxBlocks`).

| action | |
|---|---|
| `we_status` *ne* | Is WorldEdit there for me (settings, announced channels, then a `/we version` probe), my selection, clipboard and limit. |
| `we_select` *ne* | `//pos1` / `//pos2` from two corners, or a box around the asking player. |
| `we_set`, `we_replace`, `we_walls`, `we_outline`, `we_hollow` *ne* | Region edits on the selection, refused over the limit or in protected areas. |
| `we_copy`, `we_cut`, `we_paste`, `we_rotate`, `we_flip` | Clipboard; `we_paste` checks the clipboard size (`//size -c`) first and can walk to x y z. |
| `we_undo`, `we_redo` *ne* | History. |
| `we_schem_list`, `we_schem_load`, `we_schem_save` *ne* | [Schematics](/guide/blueprints#import) in the server's WorldEdit folder. |
| `we_raw` *ne* | One whitelisted `//` command (expand, stack, smooth...). |
| `we_build` | A library blueprint through WorldEdit when the server has a schematic of that name, else the normal `build`. |

Observe hook: `worldedit` (only when it is available).

### progression
| action | |
|---|---|
| `upgrade_tools` | Climb the tool tiers as far as it can now: stone tools, a furnace, iron (smelted with coal or charcoal), diamond if it has diamonds; armour optionally. Says what is missing. |

See [Tool progression](./guide/progression.md).

### mods
Not in a bundle; add `modsSkill()`.

| action | |
|---|---|
| `mods` *ne* | The mods on this server and how many items, blocks and mobs each adds. |
| `mod_items` *ne* | Exact names a mod adds, optionally filtered by a word. |
| `creative_get` | Creative mode only: put any item (vanilla or modded) into the inventory. |

### pickup
| action | |
|---|---|
| `pickup_items` | Walk over dropped items within a radius, optionally only one item type. Skips drops it can't reach. |

Observe hook: `droppedItemsNearby`.

## Helpers for skill authors

`src/skills/world.ts` and `pickup.ts` export the pieces the extended skills are built from:
`placeAt(bot, item, pos, signal)`, `reachBlock(bot, pos, signal)`,
`pickupNearby(bot, signal, opts)`, `findFreeSpot(bot)`, `findItem`, `countItem`, `vec`.

Actions that need other actions' work inside their own lock call the shared bodies directly
(calling `agent.act` from inside an action would replace it): `craftItem` (crafting.ts),
`fellTree` (woodcutting.ts), `collectBlocks` (gather.ts), `gatherMaterials` (materials.ts),
`buildStructure` (construction.ts), `ensureTool(bot, signal, kind)` (toolkit.ts) and
`startFarm` (food.ts).

## Trying actions on a live server

`scripts/skill-test.ts` joins with both bundles and runs actions in order:

```sh
MC_CAN_DIG=true node scripts/skill-test.ts scan 'chop_tree {"radius":16}' 'craft {"item":"stick","count":4}' inventory
```

`scan` lists nearby logs, crops and containers; `observe` prints the world snapshot.
