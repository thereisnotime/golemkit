## Context

Mineflayer places a block by clicking a face of a neighbour. The server decides the placed
block's state from the clicked face, the click position on that face (the cursor) and the
player's look direction at the moment the click arrives. Vanilla 1.21 does not check that the
look points at the clicked face, and checks reach as the distance from the eyes to the nearest
point of the clicked block (4.5 + 1 slack).

## Goals / Non-Goals

- Goals: get the facing/half/axis/hinge a blueprint asks for, verify it, fix it once; houses that
  look like a player built them; graceful degradation when materials are missing.
- Non-goals: scaffolding for tall builds, double slabs, redstone orientation, stair shapes beyond
  what the neighbours produce, a blueprint library (follow-up change).

## Decisions

### Placement planner (pure, `blockstate.ts`)

`planPlacement(item, state, env)` returns options `{ ref, face, cursor, yaw?, pitch?, activate? }`
ordered best first, from a block family (`familyOf`):

| family | rule used |
|---|---|
| stairs | yaw = facing; half from face (top face of the block below = bottom, bottom face of the block above = top) or cursor y 0.25/0.75 on a side |
| slab | same halves; never the top of a same bottom slab (it would merge) |
| pillar (logs) | only faces on the wanted axis |
| door | block below, yaw = facing, cursor x/z picks the hinge (DoorBlock#getHinge when neighbours are even) |
| trapdoor | side face = facing with cursor y for the half, or top/bottom face with yaw = opposite; `open` by using it after |
| wall-mounted (wall torch, ladder) | the wall behind it, level look at the wall |
| torch / lantern | look straight down (standing) or up (hanging) |
| bed | block below, yaw = facing, head cell must be free |
| look / look-opposite | fence gates face the look; chests, furnaces, barrels face the player |

An empty list means "nothing to click for that state yet": the build defers the cell and retries
after each later placement, then places it plain as a last resort (the quality pass reports it).

The bot side (`placement.ts`) picks where to stand with `rankStands` (eyes within 4.4 of the
clicked block's nearest point, not inside the cells being filled, nearest first), walks there,
sends the look with `bot.look(yaw, pitch, true)`, waits a physics tick so the look packet goes out
first, clicks with `_placeBlockWithOptions({ delta: cursor, forceLook: 'ignore' })`, then reads
the block back with `checkCell`. A wrong hard property (facing, half, axis...) is broken and
placed again with the next option once; only `open` wrong is fixed by using the block.

### Verification and fixes

`checkCell` compares only the properties the plan names and the block has (so a fence standing in
for a pane is fine). `shape` and `hinge` are soft: they follow neighbours and are reported, not
fixed. `fixFor` maps a check to `place | toggle | replace | report | none`; foreign blocks are never
broken. `summarize` produces the built/total count and optional skips with reasons.

### Blueprint format

Palette values: `role`, `role[k=v,...]`, `{ role, state }`, `{ block, state }` or
`minecraft:block[k=v]` (plain blocks get an implicit exact role, so imported schematics can map
onto them). Role fields added: `kind: furnish`, `wood`, `state`, `fallback`, `gather`. Top-level
`stairs` names the role for `^ v < >`, `meta` is free-form. `rotate` turns facings and swaps x/z
axes. Passive cells (`part=head`, `half=upper`) are filled by their other half and only need to be
clear. `loadBlueprints(dirs[])` merges directories, later wins; `build` reads
`settings.build.blueprintDirs` after the shipped directory.

### Materials

`planWood` gained cobblestone (furnace recipe), wool (beds, carpets), glass (panes), charcoal
(torches without coal), a furnace for smelting (reused as the furnished furnace by picking it up
again), fuel planks and a pickaxe. Extras that need exploration (stone for an optional furnace,
coal ore, sand) are only fetched when exposed nearby, so optional items never send the bot
tunnelling. Fallbacks for unobtainable optional items are gathered last.

### Site

`chooseSite` with digging allowed accepts up to 3 blocks of relief: bumps one above the floor
base are dug, dips up to two deep are filled (`fillCells`) with dirt or cobblestone. The door
faces the requester unless the ground in front is blocked, then the next best side
(`facingsToward` + `pickFacing`).

## Risks / Trade-offs

- Free yaw is not validated by vanilla; a strict anticheat could flag it. The look is sent before
  the click and the pitch kept natural.
- Bigger houses need many logs (small_house ~45, cottage ~85); gathering dominates build time.
- Roofs higher than reach from the floor would need scaffolding; the shipped blueprints keep the
  ridge within reach from inside.
