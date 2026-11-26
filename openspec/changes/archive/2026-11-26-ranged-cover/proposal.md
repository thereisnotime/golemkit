# Ranged cover that works under fire

## Why
Pax (stone tools, no armour) died to three pillagers on snowy ground on 25 Nov 2026. The log
showed `building cover at 527 61 -61: 1 spruce_log on a 1-block pillar`, then `placed 0 of 2
blocks`, then a burst of `retreat (... heavy fire, getting out of sight (cover 15 blocks off is
too slow))` and `(cover 7 blocks off is too slow)` lines many times a second until it was shot.

Root causes found in the code:
- The wall was planned while the bot was still moving (just off a sprinting retreat, knocked back
  by a bolt, or sliding on ice) and built without stopping. `pillarUp` read the cell under the bot
  from wherever it happened to be at that moment and jumped without being on the ground, so the
  reference block was air (`nothing solid under the feet`, zero placed) or the bot was still in
  the cell when it placed and the server refused it.
- `pillarUp` took `floor(y)` as the feet cell, which is the block itself when standing on a path
  block, farmland or soul sand, so it placed into a full block.
- Every snow block counted as replaceable. The server only replaces a single snow layer; 2+
  layers refuse any other block.
- Failures were swallowed, so the log never said why.
- Under heavy fire a far cover spot or a 3+ block wall always lost to backing off, and backing off
  in the open is how it died; the decision changed every pass with the cover distance in the
  reason, so it flapped between retreat and cover and logged each pass.
- The filler pick was the most plentiful block, so logs went before cobblestone.

## What changes
- Before building, ranged_defense stops, waits to stand still on the ground and plans the wall
  again from there. `pillarUp` waits for the ground before each jump, finds the feet cell above a
  low block, and reports why it stopped. Deep snow in a cell is dug out first (when digging is
  allowed); snow layers, grass and ferns are never reference faces. A failed wall logs why.
- Cover blocks: cobblestone and dirt first, logs and planks last (`pickCoverBlock`).
- New way of hiding, dig in: with digging allowed it digs the block under its feet and stands in
  the hole, plus a block or two toward the shooters (`digInRefusal`, `digInSeconds`). Not ice,
  ores or base blocks, not protected, not over a drop, lava or water, no liquid beside the hole.
- Under heavy fire it takes whichever of cover, a wall here or digging in leaves it the shortest
  time in the open, as long as that is under 3 expected hits; only then does it back off, towards
  home when home lies away from the shooters.
- Hysteresis: a way of hiding is kept for at least `commitSeconds` (2) while it still works
  (`holdDecision`), and the log notes a change of plan once instead of every pass.
- ranged_defense options: `digIn` (default on) and `commitSeconds` (default 2).
- Bots still only defend once shot at or aimed at; nothing here attacks.
