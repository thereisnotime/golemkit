# Floor hole fills

## Why
Base safety listed holes in Pax's fortress floor (557 67 -41, 557 67 -40, 554 67 -48, 555 67 -41)
for hours and the `integrity` project never got rid of them. Every session after the torch-step
fix still ended with "failed: torch is already there", and the step left was a fill: a fill into
a cell holding a torch (its own lighting puts torches on hole bottoms, which look like spawn
spots) can never go in, so it was retried every session. Holes over the flooded cave under the
floor ran down into the open space below, and the fill started at the bottom block, which had
nothing to be placed against. The floor block went in as whatever filler it carried most of
(spruce logs) and it only fetched cobblestone from its chests when it carried no filler at all.
Cells holding crops, a sapling, a rail or a sign also counted as holes that could never be
filled.

## What changes
- Pure planner (`baseSafetyPlan.ts`): `holeCellKind` sorts what is in a cell (solid, meant open,
  open, clear = torch or flower, keep = somebody's thing). A floor cell holding a `keep` block is
  no hole. A hole records whether it sits on solid ground (`supported`) and which cells hold a
  torch or flower (`clear`). `planHoleFills` fills a supported hole bottom up and only plugs the
  floor block of one over a cave, deeper than `depth` or ending on a non-solid block.
  `fillStepTarget` says what a fill step does with its cell now (place, clear, skip, done), for
  holes and cavity fills alike. `pickFiller` picks the block: soil first in the farm plot, floor
  stone first for the floor block, then other stone, dirt, planks, logs last.
- Glue (`baseSafety.ts`): steps into cells holding a full block or a `keep` block are dropped;
  a torch or flower is dug out first; floor stone is taken from its chests when it carries none
  for the floor blocks; a step with nothing to place against yet gets a second go at the end of
  the session; a placement that did not take counts as failed.
- Setting `baseSafety.clearFixtures` (default on), live toggle, docs.
