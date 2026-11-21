# Tool progression and faster gathering

## Why

Pax took far longer than a player to gather a 196-block fortress. It never got past wooden
tools, part of what it chopped or mined never reached its inventory (tops of tall spruce left
standing, drops left on the ground, the log stack stuck in the 2x2 crafting grid after a
craft the laggy server didn't confirm), and
`collect cobblestone` spent minutes on "Took to long to decide path to goal!" for buried stone.

## What changes

- New `progression` skill: a pure planner `nextToolUpgrade(inventory, nearby, gameMode)` for
  wood -> stone -> iron -> diamond tools (pickaxe, axe, shovel, sword, optional iron armour),
  and the `upgrade_tools` action that runs the steps (mine cobblestone, craft a furnace, make
  charcoal when there is no coal, smelt iron, craft tools). In creative it takes the tools.
- Cheap upgrades run automatically before long gathers (`gather_materials`, `collect` of stone,
  every `chop_tree`): stone tools as soon as there is a wooden pickaxe.
- New behaviour `keep_tools_upgraded` (re-crafts worn tools, upgrades when idle), armed for Pax
  with `upTo: iron`.
- New stone mining (`mining.ts`): nearest exposed stone first, then a safe staircase down and a
  3-wide strip in the stone layer instead of pathing to buried blocks. Safety checks: never dig
  under its own feet, no lava or water next to a dug block, a solid floor under every step,
  no unloaded blocks, only natural blocks outside protected areas.
- Woodcutting climbs tall trunks on a pillar it removes again, sweeps drops (frees drops
  caught in leaves) and reports how many felled logs reached the inventory.
- Crafting re-syncs the inventory after 2x2 crafts and empties the crafting grid, keeps two
  inventory slots free (throws junk) and picks up anything that fell out.
- `collect` sweeps every drop, not only the nearest one, and no longer mines placed cobblestone.
- `gather_materials` plans the wood for a pickaxe when stone is wanted, gets stone tools after
  the first 3 cobblestone, and picks the wall material for templates like the fortress
  (cobblestone with few trees, planks without a pickaxe or stone).
- Timing: results carry seconds and blocks per minute; `scripts/speed-test.ts` measures runs.
- Core: the pathfinder plans for 10 s instead of 5 s (`pathfinder.thinkTimeoutMs`, live
  toggle) and sprinting/parkour are set explicitly.

## Impact

Skills: progression (new), mining (new), efficiency (new), woodcutting, gather, materials,
crafting (smeltItem extracted), world (digBlock settle time), mods (creative_get exported).
Behaviours: keep_tools_upgraded (new). Core: agent.ts pathfinder settings, one new toggle.
