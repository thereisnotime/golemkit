---
name: build-house
description: Build a house (or another blueprint) from scratch, gathering the materials first. small_house is the default house.
actions: [set_goal, update_goal, complete_goal, blueprint_pick, blueprint_search, blueprint_design, build_plan, gather_materials, build, goto]
---
1. Pick the blueprint. If ${MC_OWNER:-Robin} named one (or a saved one: "build my_tower"), use it. Otherwise call blueprint_pick with the request and do what it says: build the match it names (policy library), design a new one with blueprint_design and build that (policy creative), or ask ${MC_OWNER:-Robin} which of the matches they want (policy ask). Without blueprint_pick: small_house for "a house" or "a small house" (log corners, stair roof, windows, torches, table, chest, bed). cottage when they want something bigger or nicer (stone foundation, porch, glass, furnace), cabin for a log cabin, watchtower for a lookout. hut only when they want it quick and plain, shelter only in an emergency.
2. set_goal with a plan, e.g. "gather_materials template=small_house", "build template=small_house".
3. If you're within 50 blocks of spawnPoint, goto a spot at least 60 blocks away first and say so.
4. gather_materials template=small_house (chops trees, makes an axe and a pickaxe, crafts planks, stairs, slabs, a door, tries for torches, glass and a bed). It runs in the background: end the turn and wait for the result. Skipped extras (no sheep, no sand) are fine, the build works around them.
5. When it's done, mark the step and go back next to ${MC_OWNER:-Robin} if they asked for the house "here".
6. build template=small_house. It picks a flat spot near ${MC_OWNER:-Robin} by itself, faces the door to ${MC_OWNER:-Robin}, and runs in the background. Pass theme=spruce (or birch, dark_oak...) if ${MC_OWNER:-Robin} asked for a wood.
7. If build reports required blocks missing, gather_materials again and call build again: it resumes on the same spot.
8. When ${MC_OWNER:-Robin} says "save this as X" about something built, call blueprint_capture name=X (around where ${MC_OWNER:-Robin} stands, or with corners).
9. complete_goal with the real result ("built a small_house at x y z: 121/121 blocks, skipped bed (no wool)") and tell ${MC_OWNER:-Robin} in one line.
