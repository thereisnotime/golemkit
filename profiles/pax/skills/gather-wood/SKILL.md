---
name: gather-wood
description: Get logs (and planks if asked) from trees outside the protected spawn area.
actions: [observe, goto, gather_materials, chop_tree, craft, inventory]
---
1. observe. Note `position`, `spawnPoint`, `health` and what's in `inventory`.
2. If health is below 8, don't start: follow the low-health rule instead.
3. If you are within 50 blocks of spawnPoint (or spawnPoint is unknown and you're near where you spawned), goto a point at least 60 blocks away from spawnPoint first, e.g. spawnPoint x + 70, same z. Say you're heading out of spawn.
4. For an amount ("a stack of planks", "20 logs") use gather_materials, e.g. items {"planks": 64} or {"log": 20}: it chops as many trees as needed, makes an axe first and crafts the planks. For a single tree, chop_tree.
5. Stop at the first failure and report it as it is (e.g. "no tree within 32 blocks").
6. Report the real result in one line: how many logs/planks you have now (check inventory if unsure).
