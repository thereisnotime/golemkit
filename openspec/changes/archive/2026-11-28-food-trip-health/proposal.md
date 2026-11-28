## Why
Live: Pax at 6 health and 12 food refused every food trip (rabbits found 285 blocks out) for "health 6/20 (needs 12)", retrying every 25 s. Under 18 food health doesn't regenerate, so the wait never ended until food fell to the starving bar, at which point it would leave weaker still.

## What Changes
- New trip setting `trips.foodMinHealth` (default 6): a food trip with the food bar under 18 needs only this much health. Other trips, and food trips when well fed, keep `trips.minHealth`.
