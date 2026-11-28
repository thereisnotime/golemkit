---
scope: minecraft
---

# Start over

Sometimes a base is in the wrong place. Pax built its fortress at 560 67 -43 in a snowy biome. There
was no grass for seeds, the shores were frozen, the nearest animals were 285 blocks away, the pantry
was empty, and it died 16 times in one night. Moving a base block by block isn't worth it.
`start_over` packs the best things, leaves the old base behind and starts again somewhere better.

```
pax start over                 (the LLM calls start_over)
!start_over                    the same as a command
!start_over direction=e        go east
!start_over status=true        how far it got
!start_over cancel=true        stop; home becomes where it stands
```

Or from the profile, once:

```yaml
settings:
  startOver: { go: true, avoid: [{ name: village, x: -2770, z: 1090, radius: 500 }] }
behaviors:
  start_over: {}               # armed by default on the companion variant
```

A start-over only starts in one of `startOver.dimensions` (the overworld by default); the
action refuses elsewhere and `go` waits until the bot is back. A run under way waits while the bot
is in another dimension than its old base.

`go: true` fires when the bot starts. The run is stored in `data/bots/<name>/store.json` under
`startOver`. Once that key exists, even as settled or failed, `go` doesn't fire again. To run it a
second time, call the action, or set `startOver.run` to a new id (`run: "2"`). That run starts
from the current home and keeps the first `old_base`. A new `run` id while a run is still
travelling redirects it: the new `direction`, fresh turns and range, the same origin.

## Steps

The `start_over` behaviour runs these steps. Each one is a log line `start_over: ...` and a
`start_over` journal event. The state (`packing`, `travelling` with its heading and leg count,
`settling`, `settled`, `failed`) lives in storage, so after a restart or a death it carries on where
it was.

1. **Pack.** It looks into its chests near home (`check_chests`). If its inventory is crowded, it
   first puts what isn't worth taking into the old chests. Its own bed by home is broken and
   picked up, so the respawn point goes with it. Then it takes the most precious things first,
   until only `freeSlots` slots are left free (`packPlan` in `src/skills/startOverPlan.ts`):
   - diamonds, netherite and emeralds;
   - iron, gold, redstone, lapis and copper (ores and ingots);
   - one of each gear slot, and only if it is better than what it carries: weapon, tools, armour,
     shield, bow;
   - arrows, food (a stack in all), seeds, torches, coal;
   - a stack of logs, a stack of cobblestone, a few saplings.

   `startOver.take` puts items first and `startOver.leave` keeps items out. Both take exact names,
   `prefix*` or `*suffix`.
2. **Leave.** Home and everything tied to the old base is dropped from storage:
   - the storage keys modules registered as base-anchored (`baseAnchored` in
     `src/core/baseAnchored.ts`): the base-project anchor and progress, farms, the spawn bed, the
     ring searches (they only remember a radius around home), plus `dropKeys`;
   - places with a registered base name (`farm:*`, `farm_plot`, `furnace`, `fortress`, `base`,
     plus `dropPlaces`) wherever they are;
   - farm and home site records;
   - places, remembered containers, food spots and its beds within `oldBaseRadius` (256) blocks
     of the old base.

   A module that keeps state around its base registers it when it loads, for example
   `baseAnchored({ keys: ['kiln.state'], places: ['kiln'] })`, and start_over drops it without
   knowing the module.

   Base safety, integrity, fortress repair and the plot farm all hang off the base anchor, so they
   stop. The old base stays as the place `old_base`, for reference only. Torches, its own blocks,
   mines and tree spots stay: everything that uses them filters by distance from home. While it
   travels, `home.away` is set (`setHomeAway` in `src/skills/navigation.ts`) so the NPC controller
   doesn't put home wherever it stands after a restart. The flag names its owner, and reading it
   asks the owner whether the reason still holds: once no run is under way (settled, given up,
   cancelled, or the state removed) it is cleared. A run whose behaviour is disarmed is paused,
   not finished, so the flag stays; `!start_over cancel=true` ends it.
3. **Go.** It picks a heading. That is `startOver.direction` if set. Otherwise it is the compass
   direction whose path stays furthest from world spawn (`spawnRadius`) and the `avoid` points,
   and away from them. Then it walks legs of `legLength` blocks with `travel`, which avoids water
   and finds its own detours. Before each leg it checks the ground along it. If the leg would end
   in water or on ice (frozen oceans have holes and drowned under them), or pass over water half or
   three quarters of the way, it takes the first of the `detours` (45 then 90 degrees either side)
   that stays on land. If there is none (an ocean ahead) and it stands on land, it turns instead
   of swimming. A leg that gets nowhere (a failed leg that moved under `blockedMoved` blocks)
   makes the next one take the next detour. After a leg that works it is back on the main heading. It walks by day only. `duskSeconds`
   (30) before dark it stops, and at night it digs in (`bunker`, until morning). If that fails
   on protected ground (world spawn after a death), it walks `protectedStep` (24) blocks on and tries again; other
   failures move it `shelterStep` (12) blocks on, and after `shelterTries` (3) of those it waits for the morning where it is. Meals and
   danger still go first: keep_fed, stay_safe and recover_drops all outrank it.
4. **Look.** Once it is `minDistance` (500) blocks from the old base and outside the avoid points,
   it looks around after every leg (`siteVerdict`). It wants:
   - `minGrass` grass blocks open to the sky within `lookRadius` (32);
   - `minLogs` tree logs within `lookRadius`, no deeper than `treeDepth` under the surface;
   - `minWater` water sources that don't freeze within `waterRadius` (64; with `iceAsWater`
     surface ice counts);
   - `minAnimals` passive animals within `animalRadius` (64).

   The place must not be in a bad biome (`badBiomes`, by default snowy and frozen ones; with
   `badCold` also anywhere water freezes), a protected area, or next to somebody's build (more
   than `maxBuildBlocks` blocks of planks, glass, doors, farmland...). The first place that passes
   is the one. Places that fail still get a score (`weights`, `caps`) for "the best seen so far".
   After `turnAfterRejects` (3) rejected places in a row, for whatever reason, the main heading
   turns.
5. **Range.** After a turn, the range counts the blocks actually walked, so short legs in the
   mountains don't use it up. At `maxDistance` (1500) without a good place, it settles at the best place it looked
   at, if that place had at least `fallback.grass` grass and `fallback.logs` logs and wasn't in a
   bad biome, protected or built on.
   Otherwise it turns and tries that way for the same length, up to `maxTurns` times.

   Every turn (the range, an ocean, rejects in a row) picks among the compass headings the run
   hasn't tried yet (and, at an ocean, the dry ones) the one whose path stays furthest from the
   avoid points and the old base, the same way the first heading was picked.
   After that it settles at the best place it looked at even if it failed the rules. If it can't walk
   there, it tries again up to `settleTries` (5) times before settling where it stands, and only if it never
   looked anywhere does it make home where it stands.
6. **Settle.** Home goes there, the bed goes down (`place_bed`), a chest goes down (`place_chest`,
   crafted from planks if needed), and the `stash` kinds (gems, metal, ores, redstone and lapis) go into the chest. Tools, food, seeds, logs
   and torches stay on it for the work ahead. It tells the owner where and why. From then on its
   usual behaviours work around the new home as on a new world:
   - keep_spawn_bed sleeps in the bed at night, which sets the spawn point;
   - farm_setup and keep_fed start a farm;
   - wood, tools and mining work around the new home;
   - base projects plan a fresh base at the new home.

## Settings

All under `settings.startOver`, all live (`!config_set startOver.minDistance 800`). Each key falls
back to its default on its own when its value is bad. The full list with ranges is in the
[feature toggles](./live-config#what-can-be-changed) table (`startOver.*`); the type and range of
each key live only in those toggle schemas, and the planner reads its settings through them.

| key | default | what |
|---|---|---|
| `go` | off | start once by itself on start |
| `run` | (none) | with `go`: a new id starts one more run, or redirects one under way |
| `minDistance` | 500 | settle no closer than this to the old base |
| `maxDistance` | 1500 | look no further than this before turning |
| `legLength` / `legMinutes` | 96 / 4 | blocks per leg; a leg taking longer counts as blocked |
| `blockedMoved` | 16 | a failed leg that moved less than this counts as blocked |
| `detours` | [45, 90] | angles tried either side of the heading around a blocked or wet leg |
| `direction` | (auto) | `n`, `ne`, `e`, ... |
| `dimensions` | [overworld] | where a start-over may run |
| `spawnRadius` | 300 | keep this far from world spawn |
| `avoid` / `avoidRadius` | [] / 400 | more places to keep away from: `{ name, x, z, radius }`; radius defaults to `avoidRadius` |
| `take` / `leave` | [] | item names packed first / never |
| `freeSlots` / `packRadius` / `roomAbove` | 2 / 48 / 24 | slots left free; chests packed from; used slots above which it makes room first |
| `stash` | [gem, metal, ore, dust] | pack kinds (`packKind`) put into the new chest |
| `minGrass` / `minLogs` / `minWater` / `minAnimals` | 24 / 8 / 1 / 2 | what a good place needs |
| `maxBuildBlocks` | 6 | somebody's build nearby rules a place out |
| `badBiomes` | [snowy_\*, frozen_\*, ice_spikes, grove, jagged_peaks] | biomes ruled out (`prefix*`, `*suffix`); `[]` = any biome |
| `badCold` | on | a place where water freezes counts as a bad biome |
| `iceAsWater` | off | surface ice counts as water |
| `lookRadius` / `waterRadius` / `animalRadius` / `treeDepth` | 32 / 64 / 64 / 12 | how far it looks; logs deeper than `treeDepth` under the surface aren't trees |
| `weights` | grass 0.25, logs 1, water 3, animals 4, badBiome 100, build 10 | the site score |
| `caps` | grass 200, logs 60, water 10, animals 10 | counts above these don't add to the score |
| `fallback` | grass 8, logs 4 | what the fallback place needs once the range is used up |
| `turnAfterRejects` | 3 | rejected looks in a row (any reason) before turning |
| `maxTurns` | 2 | turns before making do |
| `duskSeconds` / `leaveDaylightSeconds` | 30 / 120 | stop walking before dark; daylight needed to pack and leave |
| `shelterTries` / `shelterStep` / `protectedStep` / `shelterMinutes` | 3 / 12 / 24 / 15 | night bunkers |
| `settleTries` / `settleNear` | 5 / 64 | retries of a far settle target |
| `oldBaseRadius` | 256 | what belongs to the old base |
| `dropPlaces` / `dropKeys` | [] | more places and storage keys dropped on leaving |

## Notes

- A death on the way sends it back to the world spawn, because its bed is in its bag. The run
  goes on from there with the same heading. recover_drops goes back for its things first, if it
  can.
- Chests pinned in the profile (`storage.chests`) within `oldBaseRadius` (256) blocks of `old_base` stop counting
  as its chests. Without that, keep_fed walked straight back to the old pantry. keep_fed's
  `foodPlaces` stays in the profile, so drop any entry there that names an old farm.
- The decisions are pure and unit tested in `test/start-over-plan.test.ts`: the settings, the pack
  ranking, the heading, the site verdict, the state machine and the storage clean-up.
