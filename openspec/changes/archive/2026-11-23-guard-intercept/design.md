# Design

- Interception reuses the threat ranking with a predicted position (velocity from position
  samples) and a new `intercept` reason in `guard-plan.ts`.
- Aggro pulling is a pure decision (`pullPlan`: which mob, which retreat spot away from the
  player) plus a short action inside `protect`.
- Creeper handling extends the existing creeper hit-and-back-off in `combat.ts` with the ranged
  path from `weapons.ts`.
- Success is measured with `just guard-bench`: mean hits and deaths per phase must drop against
  the current numbers (38.5 hits, 3.5 deaths in the "after" set).
