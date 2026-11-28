## Why
Pax's base safety said mine:1 (568 68 -46, on the east wall) had to be capped and retired and its own mine dug inside the walls under a hatch. For hours neither happened. The journal shows why: every integrity session failed the cap step with "torch is already there" (mine:1's first trip had put a torch on the first stair step, which is the cap cell), so the mine was never capped and never retired. And every mine trip (for iron) went down mine:2, an old mine 16 blocks outside the walls that base safety had no complaint about, so no inside mine was ever needed.

## What Changes
- A torch, ladder, rail or similar small block in a cap cell is taken out before the cap goes on (`clearForCap`).
- A close mine that is capped already is retired too, not only one capped in the same session.
- With `minePlacement: inside`, known mines outside the walls are not used for trips (new `baseSafety.useOutsideMines`, default off), so the next trip digs the inside mine with its hatch. With no free spot inside, a trip still goes down the old mine.
- A retired mine is no longer reported unsafe by the mine site check.
