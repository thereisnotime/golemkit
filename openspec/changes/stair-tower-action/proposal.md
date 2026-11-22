# Stair tower action

## Why

The village needed a staircase tower where the road planner couldn't join two levels. It was built
by a one-off script; bots can't do it themselves.

## What changes

- A `build_stair_tower` action: size 4 to 9, bottom and top heights, door and exit sides, lights
  (kind, every N steps), windows (block, every N blocks).
- Used by `connect` as a fallback when the road planner finds no route within its cut and fill
  limits.

## Status

Proposed, not started.
