# Design

- Pure parts in `blockstate.ts` (`standCandidatesIn`, `underForeignRoof`, `standCost`,
  `rankStands` with options) and `blueprint.ts` (`pickNearby`, `orderCells` with `solidNow`), so
  they are unit tested with a fake world (a hut on the floor layer, a sealed pocket below).
- Stand spots are penalised rather than excluded for "unbuilt" and "below level": a roof is
  placed from the floor inside, so standing below must stay possible.
- The search radius bounds how much the pathfinder explores for an unreachable spot; the 15 s
  think timeout stays for slow machines, the walk budget cuts the wait.
- Climbing state is a WeakSet in `survival.ts`, read by the reflexes; no core change. The action
  lock already suspends and resumes long-running actions, `goto` only had to report the abort
  as an abort.
