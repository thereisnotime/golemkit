# Design

## Recipes

Recipes come from minecraft-data through mineflayer's `recipesFor`/`recipesAll` (the server's
recipe packet is skipped because it carries modded items). `craft` takes a target item count,
converts it to recipe runs and crafts one run at a time with a short settle pause, re-picking
the recipe each run so it can switch plank types when one runs out. Batched runs
(`bot.craft(recipe, n)`) drifted from the server's slot state on the live server, so the
inventory model went wrong and the next craft failed. If a recipe needs a table and none is
within 16 blocks it places one from the inventory, or crafts one from planks first, and says
where it put it.

## Smelting

`smelt` opens the nearest furnace (or places one), loads fuel for the requested count (vanilla
burn values: coal 8, planks/logs 1.5, sticks 0.5), then polls the output slot once a second with
`sleep(…, signal)` until everything came out, the furnace stops burning, or a deadline based on
10 s per item passes. The furnace window is always closed in `finally`.

## Containers

Chests, trapped chests, barrels and shulker boxes. `deposit item=all` keeps tools, armour, food
and an optional keep list; the selection is a pure function (`selectDeposits`). The bot
remembers what it saw in each container (in memory, per agent). `list_container` is
non-exclusive: it only opens a container when it is within reach and the body is idle,
otherwise it answers from memory.

## Farming

Maturity comes from the block `age` property (wheat/carrots/potatoes 7, beetroot 3). Harvest
digs ripe crops, replants with the matching seed, picks up drops every few crops, then fills
any farmland it left bare once the seeds from the drops are in. Harvest and plant don't need
`canDig` (they don't change terrain); `till` does.

## Woodcutting

`chop_tree` only fells natural trees: it walks the connected logs from the trunk base (26
neighbourhood, up to 4 blocks sideways, 80 logs) and requires at least three non-persistent
leaves touching them. Player-placed leaves are persistent, so log walls and houses are skipped.
Logs are cut bottom-up; logs the bot cannot get into reach of are skipped and reported. The
best tool comes from `bot.pathfinder.bestHarvestTool`, so no extra plugin is needed
(`mineflayer-tool` pins an old mineflayer).

## Placement

`placeAt` refuses occupied spots, picks the first full solid neighbour that isn't modded or
interactive (clicking a chest would open it), walks with `GoalPlaceBlock` so the bot never
stands in the target, and treats a placeBlock timeout as success if the block is there.

## Refused digs

Spawn protection (and claim plugins) refuse a break by sending a block update with the old
state as digging starts. Mineflayer ignores it and sets the block to air locally when the dig
timer ends, so the bot believes it broke something that is still there, and later pathfinds
into phantom air. `digBlock` (world.ts) watches `block_change` for the target during the dig,
restores the real state into the client world and throws `DigRefusedError`; chop_tree and
harvest turn that into a "protected area?" failure instead of reporting success.

## Timeouts

Pathfinder can wander for minutes towards a goal it cannot reach (top logs of a tall tree).
`gotoWithin` wraps `goto` with a time limit and converts the timeout into a plain error so the
caller skips that target; the action signal still aborts immediately.
