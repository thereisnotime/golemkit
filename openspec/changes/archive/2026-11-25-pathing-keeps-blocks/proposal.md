# Pathing keeps beds and base blocks

## Why
Pax lost its respawn point every few minutes. The journal showed `block_broken red_bed` at its
own bed (560 69 -45) with no action that digs: with `canDig` on, the pathfinder walked to the home
point next to the bed and tunnelled through the bed, `collect_drops` picked it up and
`keep_spawn_bed` put it back. Mineflayer-pathfinder only protects chests by default.

## What changes
- The Minecraft adapter adds beds, storage (chests, barrels, shulker boxes, hoppers),
  workstations (crafting table, furnaces, anvils, ...), doors, trapdoors, fence gates, signs,
  banners, torches and lanterns, glass and farmland to the pathfinder's never-break set
  (`src/adapters/minecraft-java/noBreak.ts`). Paths go around them.
- Explicit digs (`dig`, `clear_area`, building) are unchanged.
