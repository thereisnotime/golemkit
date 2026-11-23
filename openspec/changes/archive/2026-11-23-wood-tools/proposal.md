# Wood and tools recover on their own

## Why
Pax (profiles/pax.yaml) spent hours failing the same two things. `chop_tree` said "no natural tree within 32 blocks" every 15 minutes: it had cleared the trees around the fortress and never looked further. `upgrade_tools` said "could not make sticks for a stone pickaxe" 80 times while carrying spruce logs: it held 1 oak and 1 spruce plank, counted them as the 2 planks the sticks needed, and the stick recipe (one plank kind) failed without ever turning a log into planks. It had no sword, so it fought with its fists.

## What changes
- Wood is counted per plank kind (`usablePlankUnits`), and sticks and tools top up one kind from the logs (`plankTopUp`, `ensureSamePlanks`).
- The tool order is pickaxe, sword, axe, shovel; a wooden sword comes early when there is no cobblestone and wood to spare.
- `upgrade_tools` takes wood from the bot's own chests nearby, then fells a tree within 32 blocks, else fails with `data.need = 'wood'`.
- `keep_tools_upgraded` turns that into a blackboard `wood` need; `chop_wood_loop` scores higher while it is set.
- The NPC controller takes an optional `retryKey` per behaviour: a changed key ends a failure back-off early. `keep_tools_upgraded` keys on the usable wood.
- The wood ladder (`chop_tree rings`, `chop_wood_loop rings`, default 32, 64, 128, 250): remembered tree spots, then widening rings, scans close and scouting trips out and back further out, empty rings remembered for 20 minutes. Pure planner in `src/skills/treePlan.ts`.
