# Design

## Target resolution

`resolveTarget(text, names)` is pure. Order: structure words (village, portal), ore families
(any of `iron`, `iron ore`, `raw_iron`, `diamonds`; both stone and deepslate variants, with the
drop), wood words (logs, trees), crops (ripe only), liquids (source blocks with air above),
chests, beds, "animals", biome words (patterns over the registry's biome names), then exact
registry names (biome, mob, block, item, in that order, so "chicken" is the mob), then modded
names by their bare name when exactly one mod has it. Plurals and articles are stripped first.
Modded blocks are all `modded_block` in the world (see `core/modded.ts`), so a modded block
resolves to an item: it can be brought from the inventory, chests or crafting, not found.

## Search phases

`searchPhases()` returns `view`, `memory` (not for biomes), `scout`, and `prospect` for ores
when asked (always with `bring`), digging is allowed and the strip mine (a staircase at most 20
blocks down) reaches the ore's height band. The scout is find_food's loop with the target's look
function: day only by default, stop at low health with mobs near, skip wet waypoints and
protected areas, climb out when a leg goes underground. Ores in loaded chunks are visible
through the ground (the bot has the chunk data); the report says how far below the surface they are.

## Village and portal

A village is a bell with beds or villagers, three villagers with two beds, two villagers with
two beds and a job site, or (abandoned) three beds, two job sites and eight path blocks, all
within 48 blocks of a bell, villager or bed. A portal is a lit portal block, or obsidian that
outlines a vertical 4..23 by 5..23 rectangle with only the corners allowed missing.

## bring_item

`bringSteps()` orders inventory, own chests, craft, smelt, gather, find, leaving out what can't
work. Generic wood products (`planks`, sticks, tables, chests) go through `gather_materials`
(chop any tree, then craft). Planks of one wood, bread, sticks, torches and hay craft from one
level of ingredients that are obtained the same way (`ingredientFor`: oak planks need oak logs,
dug as oak logs rather than felling whatever tree is nearest; bread needs wheat, harvested from
the bot's own farms or village farms, where a villager is within 24 blocks, and replanted).
Ingots, glass, stone, charcoal and cooked food are smelted from their input (`SMELTS`), with a
furnace crafted from 8 cobblestone when there is none and planks as fuel when there is no coal.
The intents brain calls `bring_item` with normalised names (`iron_ingot`, generic `log` and
`planks`), all of which this covers. Crafting tables and furnaces put down along the way are dug up again.

Own chests are ones the bot placed (recorded by wrapping `bot.placeBlock` in the skill's setup)
and ones listed in `settings.storage.chests`. Nothing else is ever opened for taking, whatever
`respectBuilds` says.

## Delivery

The bot walks up to the player (travel when far, then GoalFollow so a moving player is
followed), looks at them, tosses the items and watches `playerCollect` for up to 4 s.
`tossAccount()` turns before/after counts and pickups into a truthful line: given, picked up,
lying on the ground, or short of what was asked.

## Drops

The skill's setup parses death messages (`parseDeathMessage`) and records the player's position
from their entity or the last-seen tracker (every 2 s). `dropsTrip()` compares the walking time
(3.5 blocks/s) plus a 20 s margin with the 5 minute despawn; `try_anyway` goes regardless, since
items only age while the area is loaded.

## Air

Live runs on mc02 drowned the bot four times: the pathfinder walks along lake beds and a sinking
bot runs out of air. `travel()` in core now watches the air (`bot.oxygenLevel`); below 12 of 20
it stops the walk, swims straight up and carries on, giving up after the third time.

## Progress

Milestones (phase changes, found, fetching, every few legs) are whispered to the asking player
at most every 20 s; found and done always go out. Results carry the elapsed time.
