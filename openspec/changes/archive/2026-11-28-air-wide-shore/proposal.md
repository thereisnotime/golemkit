## Why
Live: Pax ended up in the middle of a lake north of the fortress at night. The air reflex swam up, looked for dry land within 12 blocks, found none, and sank again, over and over for minutes, holding the body so nothing else could get it out.

## What Changes
- After getting air, the air reflex looks for dry land out to 48 blocks (rings every 2 blocks to 12, then every 4 with 16 directions; `dryLandOffsets`), with a longer swim timeout for the far ones. Other callers of reachDryLand keep 12.
