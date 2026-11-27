# Design

## Finding cavities by sky light
Underground air has sky light 0; open air above ground has 15 and a cave mouth a gradient. The
scan treats open blocks at or below the floor level with sky light under 4 as dark and grows
cavities from them (6 neighbours) inside footprint + margin, depth below the floor. Openings are
cavity blocks next to open, not-dark air; their column says where (inside, under the walls, near).
Only cavities with an opening and spawn spots or an opening into the footprint are threats, so a
sealed pocket and a hut on the base are left alone. Without sky light data "dark" falls back to
"something solid overhead".

## Techniques as a registry
`techniques(mines)` returns named functions (cap, fill, seal, light); settings order and enable
them. Each takes the openings left by earlier ones and returns steps, what it covered and whether
the cavity is done. Fill refuses cavities that reach the box edge (a cave going on) or hold a mine;
seal never seals a mine opening; mines are capped by `planMineCaps` because their stairs are sky-lit.

## Mine caps
The cap goes over each dug block of the stairs at the entrance's ground level. The pathfinder can't
walk through trapdoors (and doors are in its no-break list), so `dig_mine` digs the caps off before
a trip and puts them back after; the mine record keeps the cells and the kind.

## Keep-out
Mining asks `digKeepOut(agent, p)`: footprint + margin, floor level down to keepOutDepth, or a death
zone. It is cached (30 s) because mining asks per candidate block. A stone dig from inside the base
first walks to the nearest column outside.

## The door
The builder used to take the door out whenever anything was left to place. `enclosedColumns` flood
fills the plan at door height from outside; the door comes out only for cells closed in behind it.
For the fortress walls stage (towers not built) nothing is closed in, so wall repairs keep the door.

## Status
Status needs to stay cheap, so base projects keep the last plan's short form (next step, stuck
reasons, waits, safety) and `SkillDef.status` returns it to the status tracker as `notes`.
