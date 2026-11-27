## Why
After the hold fix a running gear search kept its slot, but none started: a search could only start when nothing scored above the idle band (15), and chop_wood_loop (30) was nearly always armed. Pax went 16 hours without one.

## What Changes
- New `needs.search.startBelow` (default 30): a search may start while no other work scores above it; it then scores just above it and goes next when the running behaviour ends. 15 restores the old rule.

## Impact
- `src/brains/npc/needs.ts`, `src/core/needs.ts`, `src/core/toggles.ts`, docs.
