## Why
The owner wants Pax to take anything it wants, not only from chests: smelted iron in a furnace, items in a hopper or a barrel all count.

## What Changes
- `storage.anyChest` becomes `storage.anyContainer` and covers chests, barrels, shulker boxes, furnaces, smokers, blast furnaces, hoppers, droppers, dispensers, brewing stands and crafters.
- Memory tracks all of those; it still only stores things in chests, barrels and shulker boxes, and a furnace it places is not one of its chests.
