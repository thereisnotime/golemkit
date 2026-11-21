# Design

## Tool progression planner

`nextToolUpgrade(inv, nearby, gameMode, { upTo, kinds, armour })` returns one step or null:
`craft`, `gather` (logs, cobblestone, raw_iron, coal, diamond), `craft_furnace`, `smelt`,
`creative_get`. Order: a wooden pickaxe first; then stone for every kind below stone (one
cobblestone trip for all of them, plus 8 for a furnace when iron is next); then iron with the
pickaxe first; armour after the tools; diamond only from diamonds held or ore seen. A step that
can't be done (no iron ore seen) ends the plan, so the bot stops at the best tier it can reach.

Fuel for iron: coal or charcoal held; up to 3 raw iron are smelted with planks directly (1.5
smelts each, no extra furnace run); more raw iron first turns logs into charcoal (one log =
8 smelts). The planner is pure and unit tested; `upgradeTools` loops it, re-sensing between
steps, and stops on failure or when a step makes no progress.

`autoUpgrade` runs only cheap steps (craft from what is held, mine up to 20 cobblestone) and
only once a pickaxe exists; it aims for stone unless iron is already in hand.

## Stone mining

Pathing to buried stone is the expensive part on a loaded server (A* on a 3D dig-path goal).
`mineStone` instead:

1. digs stone in reach (never the column under its own feet),
2. walks to the nearest exposed stone within 12 blocks (8 s path budget, two misses max),
3. digs a staircase forward-and-down from where it stands until both blocks ahead are stone,
   then a flat 2-high tunnel widened to 3 (side blocks each checked), mining ores beside the
   tunnel the pickaxe can harvest,
4. sweeps drops and walks back up the stairs.

`planStep` (pure) returns the blocks to dig and the next standing spot, or why the step is
unsafe; unsafe steps make the bot turn, four unsafe turns end the run with the reason.

## Woodcutting

The trunk is cut from the ground as before. Logs still standing are cut from inside the trunk
column: the bot stands where the bottom log was, cuts what it reaches, pillars one block with
a filler block (or a log), repeats, then digs the pillar on the way down. Drops are swept after
a short settle; a drop sitting on natural leaves gets that leaf broken so it falls.

## Lost items

Reproduced live: 15 logs felled, `gather_materials` stopped chopping because the plan saw them,
then ended with 5 planks and no logs; a later run "found" 23 logs. After a 2x2 craft mineflayer
syncs the crafting-table window but not the player inventory, so a click the loaded server
ignored leaves the log stack in the crafting grid (slots 1-4) while the model shows it gone.
The server hands it back on a later window close, or drops it when the inventory is full
(Pax's logs found on the ground by the next call). `craftItem` now sends the no-op sync click
after inventory crafts and shift-clicks anything in the grid or on the cursor back.

Mineflayer's `putSelectedItemRange` also throws the cursor stack out when its model has no
free slot, and `putAway` of a crafting result does the same. `craftItem` frees two slots first
(junk only, never the recipe's inputs or output) and picks up any drop that appears at its feet
while crafting. Felling and mining stop with "inventory full" instead of leaving drops behind.

## Material choice

`chooseWallMaterial` (pure): held material first; planks without stone or without a pickaxe;
cobblestone when the trees around give fewer planks than needed (24 planks per tree); with
plenty of both and a pickaxe, cobblestone (the strip mine is not limited by trees and keeps
the bot in one spot). It is called from `gather_materials template=...` when no material is
given and the template's material role accepts both.

## Pathfinder

`thinkTimeout` 10 s (was the library's 5 s), configurable as `pathfinder.thinkTimeoutMs`.
Sprinting and parkour stay on, explicitly.
