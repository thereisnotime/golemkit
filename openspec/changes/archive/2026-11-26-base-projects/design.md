# Design

## Where it runs
The projects are an `active` idle chore (`base_project`) of the needs layer, not a behaviour: they
only matter when nothing else does, and the chore picker already handles mode, time of day and
cooldowns. One addition to the layer: a chore can be `sticky`, so a running session keeps the
body against a behaviour that climbs just above the idle band (collect_drops at 22 kept ending
sessions after a few seconds in the first live run); a real need still wins by the switch margin.
`work_on_base` is long-running, so a reflex (eating) suspends a session instead of ending it.

## Core vs Minecraft
Core holds what any game would need: settings, owner decisions, the queue and its policy. The
adapter side says which projects exist and how much is left of each, from a fresh survey every
time, so progress is the world plus a small state record and survives anything.

## Stages from the blueprint
The fortress is one blueprint with `meta.stages`; a stage is a role set plus glyphs (a glyph
wins, so the gate torches go with the walls and the tower torches with the towers, though both
are role `light`). The build runs on the whole blueprint with an `only` filter, so placement
order, facing, resume and the quality pass are the build's own.

## Never tearing down
Autonomous builds pass `autonomous: true`: only natural blocks and the bot's own may be dug, and
anything else in the footprint is left out instead of failing the build. The floor skips cells
with an unplanned build on top. The base's blocks get a high pathfinder dig cost.

## Doors
mineflayer-pathfinder can't walk through doors (and the adapter never breaks them), so a walled
base is closed to it. The session walks in through the gate itself for inside work; leaving, the
pathfinder still digs a wall block when there is no other way, and the next survey repairs it.
Door-aware pathing belongs in the movement layer.
