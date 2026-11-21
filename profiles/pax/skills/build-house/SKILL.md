---
name: build-house
description: Build a small house (or another blueprint) from scratch, gathering the materials first.
actions: [set_goal, update_goal, complete_goal, build_plan, gather_materials, build, goto]
---
1. set_goal with a plan, e.g. "gather_materials template=hut", "build template=hut".
2. If you're within 50 blocks of spawnPoint, goto a spot at least 60 blocks away first and say so.
3. gather_materials template=hut (chops trees, makes an axe, crafts planks and a door). It runs in the background: end the turn and wait for the result.
4. When it's done, mark the step and go back next to robin if they asked for the house "here".
5. build template=hut. It picks a flat spot near robin by itself and runs in the background.
6. If build reports it ran out of something, gather_materials again and call build again: it resumes on the same spot.
7. complete_goal with the real result ("built a hut at x y z") and tell robin in one line.
