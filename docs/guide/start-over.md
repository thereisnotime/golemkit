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

`go: true` fires when the bot starts. The run is stored in `data/bots/<name>/store.json` under
`startOver`. Once that key exists, even as settled or failed, `go` doesn't fire again. To run it a
second time, call the action.

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
   - the base-project anchor and progress (`projects.spots`, `projects.state`);
   - farms and farm site records;
   - places, remembered containers, food spots and its beds within 256 blocks of the old base;
   - the ring searches (they only remember a radius around home).

   Base safety, integrity, fortress repair and the plot farm all hang off the base anchor, so they
   stop. The old base stays as the place `old_base`, for reference only. Torches, its own blocks,
   mines and tree spots stay: everything that uses them filters by distance from home. While it
   travels, `home.away` is set so the NPC controller doesn't put home wherever it stands after a
   restart.
3. **Go.** It picks a heading. That is `startOver.direction` if set. Otherwise it is the compass
   direction whose path stays furthest from world spawn (`spawnRadius`) and the `avoid` points,
   and away from them. Then it walks legs of `legLength` blocks with `travel`, which avoids water
   and finds its own detours. A leg that gets nowhere turns the next one 45 degrees, then the other
   way, then 90; after a leg that works it is back on the main heading. It walks by day only. Half
   a minute before dark it stops, and at night it digs in (`bunker`, until morning). Meals and
   danger still go first: keep_fed, stay_safe and recover_drops all outrank it.
4. **Look.** Once it is `minDistance` (500) blocks from the old base and outside the avoid points,
   it looks around after every leg (`siteVerdict`). Within 32 blocks it wants:
   - `minGrass` grass blocks open to the sky;
   - `minLogs` tree logs;
   - `minWater` water sources that don't freeze;
   - `minAnimals` passive animals (within 64).

   The place must not be a snowy or frozen biome (unless `allowSnow`), a protected area, or next to
   somebody's build (more than `maxBuildBlocks` blocks of planks, glass, doors, farmland...). The
   first place that passes is the one.
5. **Range.** At `maxDistance` (1500) without a good place, it settles at the best place it looked
   at, if that place had at least some grass and trees and wasn't snowy, protected or built on.
   Otherwise it turns 90 degrees and tries that way for the same length, up to `maxTurns` times.
   After that it gives up and makes home where it stands.
6. **Settle.** Home goes there, the bed goes down (`place_bed`), a chest goes down (`place_chest`,
   crafted from planks if needed), and ores and ingots go into the chest. Tools, food, seeds, logs
   and torches stay on it for the work ahead. It tells the owner where and why. From then on its
   usual behaviours work around the new home as on a new world:
   - keep_spawn_bed sleeps in the bed at night, which sets the spawn point;
   - farm_setup and keep_fed start a farm;
   - wood, tools and mining work around the new home;
   - base projects plan a fresh base at the new home.

## Settings

All under `settings.startOver`, all live (`!config_set startOver.minDistance 800`). Each key falls
back to its default on its own when its value is bad.

| key | default | what |
|---|---|---|
| `go` | off | start once by itself on start |
| `minDistance` | 500 | settle no closer than this to the old base |
| `maxDistance` | 1500 | look no further than this before turning |
| `legLength` | 96 | blocks per leg |
| `legMinutes` | 4 | a leg taking longer counts as blocked |
| `direction` | (auto) | `n`, `ne`, `e`, ... |
| `spawnRadius` | 300 | keep this far from world spawn |
| `avoid` | [] | more places to keep away from: `{ name, x, z, radius }` |
| `take` / `leave` | [] | item names packed first / never |
| `freeSlots` | 2 | slots left free after packing |
| `minGrass` / `minLogs` / `minWater` / `minAnimals` | 24 / 8 / 1 / 2 | what a good place needs |
| `maxBuildBlocks` | 6 | somebody's build nearby rules a place out |
| `allowSnow` | off | snowy biomes are fine |
| `maxTurns` | 2 | 90-degree turns before making do |

## Notes

- A death on the way sends it back to the world spawn, because its bed is in its bag. The run
  goes on from there with the same heading. recover_drops goes back for its things first, if it
  can.
- Profile settings pinned to the old base, such as `storage.chests` and keep_fed's `foodPlaces`,
  stay in the profile. The chest ones are harmless, because chests count only within 48 blocks
  of home. Drop a `foodPlaces` entry that names an old farm.
- The decisions are pure and unit tested in `test/start-over-plan.test.ts`: the settings, the pack
  ranking, the heading, the site verdict, the state machine and the storage clean-up.
