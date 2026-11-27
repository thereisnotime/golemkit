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
than an open hole.

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

A new staircase mine starts at least `mineClearance` blocks from the walls (`minePlacement:
outside`), or inside the walls (`inside`, and it gets a cap), or either. Its stairs don't dig
through the keep-out. A known mine that is too close and not capped is marked `unsafe` by its
site check, so the next trip digs a new one at a better spot while the old one gets its cap.

## Death spots

When the bot dies, the spot goes into its danger memory as a zone of kind `death`, `radius`
blocks across and `yRange` blocks above and below, for `minutes`. The height band matters: a death
in a cave under the base doesn't fence off the base above, where the bot respawns. Inside the zone:

- every path costs `stepCost` more per block, so the pathfinder goes around it (it still goes
  through when there is no other way),
- `wander` doesn't pick spots in it,
- stone and ore digging doesn't dig there.

A second death in the same spot extends the zone.

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
