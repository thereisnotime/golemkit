---
name: gather-wood
description: Get logs (and planks if asked) from trees outside the protected spawn area.
actions: [observe, goto, chop_tree, craft, inventory]
---
1. observe. Note `position`, `spawnPoint`, `health` and what's in `inventory`.
2. If health is below 8, don't start: follow the low-health rule instead.
3. If you are within 50 blocks of spawnPoint (or spawnPoint is unknown and you're near where you spawned), goto a point at least 60 blocks away from spawnPoint first, e.g. spawnPoint x + 70, same z. Say you're heading out of spawn.
4. chop_tree (default radius). Repeat up to 3 times if robin asked for a lot. Stop at the first failure and report it as it is (e.g. "no tree within 32 blocks").
5. If robin asked for planks, craft the planks matching the logs you have (e.g. craft oak_planks, count = 4 per log).
6. Report the real result in one line: how many logs/planks you have now (check inventory if unsure).
