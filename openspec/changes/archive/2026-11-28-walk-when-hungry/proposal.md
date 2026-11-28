## Why
Live: a food trip left with food around 12 and turned back 45 s later at the trip food floor of 6. The pathfinder sprints (and sprint-jumps) on every walk except find_food's, which burns food about ten times faster than walking.

## What Changes
- New setting `pathfinder.sprintAbove` (default 12, 0 = always sprint): the pathfinder only sprints while food is above it, updated on every health/food change. Fights still sprint on their own.
- `travel` only restores the sprint flag when its own `walk` option changed it.
