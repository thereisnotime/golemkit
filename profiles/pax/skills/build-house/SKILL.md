---
name: build-house
description: Build a house (or another blueprint) from scratch, gathering the materials first. small_house is the default house.
actions: [set_goal, update_goal, complete_goal, build_plan, gather_materials, build, goto]
---
1. Pick the blueprint: small_house for "a house" or "a small house" (log corners, stair roof, windows, torches, table, chest, bed). cottage when they want something bigger or nicer (stone foundation, porch, glass, furnace), cabin for a log cabin, watchtower for a lookout. hut only when they want it quick and plain, shelter only in an emergency.
2. set_goal with a plan, e.g. "gather_materials template=small_house", "build template=small_house".
3. If you're within 50 blocks of spawnPoint, goto a spot at least 60 blocks away first and say so.
4. gather_materials template=small_house (chops trees, makes an axe and a pickaxe, crafts planks, stairs, slabs, a door, tries for torches, glass and a bed). It runs in the background: end the turn and wait for the result. Skipped extras (no sheep, no sand) are fine, the build works around them.
5. When it's done, mark the step and go back next to robin if they asked for the house "here".
6. build template=small_house. It picks a flat spot near robin by itself, faces the door to robin, and runs in the background. Pass theme=spruce (or birch, dark_oak...) if robin asked for a wood.
7. If build reports required blocks missing, gather_materials again and call build again: it resumes on the same spot.
8. complete_goal with the real result ("built a small_house at x y z: 121/121 blocks, skipped bed (no wool)") and tell robin in one line.
