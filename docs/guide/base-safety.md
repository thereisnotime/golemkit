---
scope: mixed
scopeNote: "The settings and the death-spot memory are game-agnostic (src/core/baseSafety.ts, danger.ts); the scan, the fixes, mine caps and the dig keep-out are Minecraft (src/skills/baseSafetyPlan.ts, baseSafety.ts, baseArea.ts, caps.ts)."
---

# Base safety

A base is only as safe as the ground under it. Pax mined the cobblestone for its fortress right
under the floor, because the nearest stone is always below home. The tunnels it left were dark,
connected to the outside, and skeletons spawned in them. One night its chores walked it down
there and it was shot while climbing out, 4 blocks under its own floor. It respawned in its bed
just above, went straight back down to fetch stone and was shot again 47 seconds later. Its
staircase mine started one block outside the east wall, unlit: another way under the walls.

Base safety deals with that in four parts:

- a **scan** of the ground under and around the base for dark cavities mobs can spawn in and reach
  the base from (or the bot can wander into),
- **fixes** for each one, from a short list of techniques,
- a **keep-out** for digging: stone and ore digging stays out of the ground under the base, and
  new mines start clear of the walls,
- **death spots**: after a death the bot keeps out of that spot for a while.

## The scan

The scan looks at the footprint of the settled base (the base blueprint where base projects put
it, or `settings.projects.base`) plus `margin` blocks around it, from `depth` blocks below the
floor up to a few above it. Every open block at or below the floor level that is dark (sky light
under 4) belongs to a cavity; cavities are grown block by block. A cavity block next to open air
that isn't dark is an **opening**: a hole in the floor, a tunnel coming out next to the walls, a
mine's stairs. A cavity is a **threat** when it has an opening and either spots a mob could spawn
on (solid below, room above, no block light) or an opening into the footprint.

A pocket with no opening is left alone: nothing gets in or out. A roofed room standing on the base
(a hut) is above the floor level and never counts.

Known staircase mines (storage `mines`) are checked on their own: their stairs are open to the sky
column by column, so they don't look dark, but an entrance inside the base, on its walls or within
`mineClearance` of them is a way under the walls. Its fix is a cap over the stairs where they cut
through the ground.

### Holes in the floor

A hole in the floor open to the sky is no cavity (it isn't dark), but the owner still sees a hole
and falls in. With `floorHoles` on (default) the scan also lists every open block at floor level
in a column inside the walls, down to the first solid block (at most `depth`): a farm's water, a
known mine's stairs (they get a cap) and cells that are part of a cavity (sealed with it) are
left out. So are cells holding something that isn't a full block but is somebody's: crops, a
sapling, a rail, a sign, a button (a fill could never go in there). Doors, trapdoors, farmland
and path blocks are full blocks to the scan, so they are never holes.

A hole on solid ground is filled from the bottom up. One that opens into a cave under the floor,
goes deeper than `depth` or ends on something that isn't solid has nothing to build up from, so
only its floor block is plugged, placed against the floor around it; what is under the plug is a
cavity for the cave fixes. A torch or flower standing in a hole (often its own torch, lighting
the hole bottom as a spawn spot) is broken first (`clearFixtures`, on by default; off leaves such
a spot alone and doesn't count it as a hole). Any fill step whose cell holds a full block by the
time it gets there is skipped, and one with nothing to place against yet gets a second go at the
end of the session, after its neighbours.

The floor block goes in as floor stone when it has some (cobblestone, cobbled deepslate, stone,
andesite...), taken from its chests when it carries none; otherwise any filler it carries: other
stone, then dirt, then planks, logs last. A hole in the farm plot base projects keep inside the
walls gets dirt first. These steps come first in the `integrity` project, with the seals.

## Fixes

The techniques run in the order of `techniques` (default `cap, fill, seal, light`); each one takes
the openings the earlier ones left, and one that finishes the cavity ends the list. Leave a
technique out to turn it off.

| technique | what | when |
|---|---|---|
| `cap` | a trapdoor (or slab, or block: `capWith`) over each open block where a mine's stairs cut the ground; `capWith: light` puts torches down the stairs instead | a known mine inside or close to the walls |
| `fill` | fills the whole cavity, from the far end back towards the openings | not more than `fillMax` blocks, not reaching past the scanned box, no mine in it |
| `seal` | fills each opening, so the cavity is cut off from the air | not more than `sealMax` openings; never a mine's |
| `light` | torches on its spawn spots, at most `lightSpacing` apart | it has spawn spots |

A cap is remembered on its mine (`cap` in the mine record): `dig_mine` takes it off before a trip
and puts it back after, since the pathfinder can't walk through a trapdoor. Without a trapdoor the
bot makes two from its planks; without planks it caps with a filler block, which is still better
than an open hole. A torch, ladder or rail standing in a cap cell (the first trip lights the first
stair step) is taken out first; without that, Pax's cap failed with "torch is already there" for
hours.

Fixing runs as the base project `integrity` (first after the walls in the default order, small,
so it never needs an ok), between other chores, in bounded sessions like the other projects.
`check_base` says what the scan found and how it would fix each thing; `secure_base` runs one
session now. While something is open, site health marks the base `unsafe` with the reason
(`sites` in storage, the journal records the change, the owners are whispered when `sites.tell`
is on).

## Keep-out for digging

Stone and ore digging (the cobblestone it mines for builds and tools, `mineStone` in mining.ts) skips blocks under the
base footprint and its margin down to `keepOutDepth` below the floor, and blocks in a recent death
spot. When the bot needs a staircase down to stone from inside the base, it first walks out past
the keep-out. Builds and the fixes above don't ask the keep-out.

## Its own mine, inside the walls

The keep-out is for stray tunnels: Pax dug 129 blocks of cave under its own floor fetching stone,
and skeletons spawned in it. A player doesn't stop digging under the base for that; they put a
shaft inside it with a hatch and go down there. So does the bot (`minePlacement: inside`, the
default):

- The entrance is a straight line of free floor columns inside the walls: the spot it starts from
  and the `HATCH_STEPS` (3) columns its stairs cut through the floor. Along a wall first (the hatch
  doesn't cut the yard in two), at least `mineKeepClear` (2) from the gate, never on the farm plot,
  the workshop or the storage row (`insideEntrances` in stairMinePlan.ts).
- Its stairs may dig the base's own floor there, and only there: blocks the bot placed or cells of
  the base blueprint. Everywhere else the keep-out holds.
- `mineHatch` (on): a trapdoor on each floor cell the stairs cut (`hatchCells`), put on after the
  first trip. It makes two from 6 planks (or 2 logs) when it has none. A wooden trapdoor is opened
  for a trip and closed after it, not broken and replaced. The site check and the floor stage leave
  the hatch and the shaft alone.
- `retireCloseMines` (on): an old mine outside the walls and within `mineClearance` of them is
  capped by the integrity check and retired (no more trips); the next trip starts the inside one.
  One that is capped already (by an earlier session, the floor, a player) is retired as well.
- `useOutsideMines` (off): with `minePlacement: inside`, a known mine outside the walls, even one
  far enough from them, is not used for trips, so the next trip (for iron, or cobblestone a repair
  needs that its chests don't hold) digs the inside one. Pax kept going down an old mine 16
  blocks out and the inside mine never got dug. Turn it on to keep using the old mine. When there
  is no free spot inside, a trip still goes down the old one rather than none.
- `minePlacement: outside` keeps the old rule (at least `mineClearance` from the walls, no digging
  through the keep-out); `either` tries inside first. With no settled base yet it starts near home.

| setting | default | what it does |
|---|---|---|
| `baseSafety.minePlacement` | `inside` | inside under a hatch, `outside`, or `either` |
| `baseSafety.mineHatch` | on | trapdoor hatch over an inside mine's stairs |
| `baseSafety.mineKeepClear` | 2 | an inside mine keeps this far from the gate |
| `baseSafety.retireCloseMines` | on | cap and retire an outside mine hugging the walls |
| `baseSafety.useOutsideMines` | off | with `inside`, still take trips down a known mine outside the walls |

## Death spots

When the bot dies, the spot goes into its danger memory as a zone of kind `death`, `radius`
blocks across and `yRange` blocks above and below, for `minutes`. The height band matters: a death
in a cave under the base doesn't fence off the base above, where the bot respawns. Inside the zone:

- every path costs `stepCost` more per block, so the pathfinder goes around it (it still goes
  through when there is no other way),
- `wander` doesn't pick spots in it,
- stone and ore digging doesn't dig there.

A second death in the same spot extends the zone.

## Respawning

A dead bot asks the server to respawn as soon as its health reads 0, also when it logs in already
dead (health 0 at login, which otherwise leaves it on the death screen with nothing running). It
logs `dead at login (health 0), respawning` or `dead (health 0), respawning`, then `respawned`.
While it stays dead it asks again every `respawn.retrySeconds` (default 5); after
`respawn.maxTries` asks (default 6) it reconnects. `respawn: false` turns this off (mineflayer's
own single ask on the death event still happens).

## Settings

Profile key `baseSafety:` (or `false`), live with `config_set baseSafety.*`:

| key | default | what |
|---|---|---|
| `enabled` | on | scan and fix |
| `margin` | 4 | blocks around the footprint checked too |
| `depth` | 8 | blocks below the floor checked |
| `techniques` | `[cap, fill, seal, light]` | fixes to use, in this order |
| `fillMax` | 48 | cavities up to this size are filled in whole |
| `sealMax` | 24 | at most this many openings of one cavity sealed |
| `lightSpacing` | 7 | torches at most this far apart |
| `capWith` | trapdoor | trapdoor, slab, block, light or none |
| `keepOutDepth` | 8 | no stone digging under the base down to this depth; 0 = off |
| `mineClearance` | 4 | a new mine starts at least this far from the walls |
| `minePlacement` | outside | outside, inside or either |
| `floorHoles` | on | also fill holes in the floor surface inside the walls (dirt in a farm plot) |
| `clearFixtures` | on | break a torch or flower standing in a hole or opening it fills; off = leave the spot alone |

Profile key `deathSpots:` (or `false`): `enabled` (on), `minutes` (10), `radius` (6), `yRange` (4),
`stepCost` (8).

## Testing

`test/base-safety-plan.test.ts` covers the scan and the techniques on a small test world (a sealed
pocket, a tunnel with a shaft into the yard, a cave going on past the box, a mine one block from
the wall), `test/base-safety.test.ts` the builder's door rule, attachments with nothing to hang
on, death spots and the queue's stuck reasons. `scripts/base-safety-test.ts` is the live check: a
test bot far from everything gets a base set by settings, the director digs a tunnel under its
floor with a shaft into the yard and a mine by the east wall, and the bot runs `check_base`,
`secure_base` and `check_base` again; everything is put back afterwards. Run it under the bench
lock: `flock .worktrees/.bench.lock node --env-file-if-exists=.env scripts/base-safety-test.ts`.
