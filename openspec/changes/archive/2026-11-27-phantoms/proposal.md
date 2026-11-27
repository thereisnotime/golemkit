## Why
Pax had not been in a bed for days, so phantoms came every night (nine at once). The reflexes only fought back after a hit, when the phantom was already climbing away, so it stood still and took about ten hits while the owner watched.

## What Changes
- `combat.phantoms` settings and a pure planner (`src/skills/phantomPlan.ts`): at night, with a bed in reach and no ground mob close, in and out of bed when phantoms are about (a bed resets their timer, they don't block sleep); to bed and stay after `insomniaMinutes` without one; out of bed when one comes close; otherwise start the fight on a close phantom before its dive.
- The reflexes remember the last bed or death (`rest.lastAt`).

## Impact
- `src/skills/phantomPlan.ts`, `src/adapters/minecraft-java/brains/reflexes.ts`, `src/core/toggles.ts`, docs.
