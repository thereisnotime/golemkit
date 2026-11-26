# Gear progression: the staircase mine, the iron chain, a gear need that keeps going

## Why
Pax (profiles/pax.yaml) has stone tools, no iron and no armour, lives on a frozen lake by its fortress, and stood idle for hours. Its gear need searched 160 blocks for exposed iron six times on 2026-11-25; every one was taken over by farm or bed work after 3 to 17 seconds, yet each counted against the six searches a day. For the rest of the day the only thing looking for iron was the `scout_nearby` idle chore, which looks within twice `idle.radius` (48 blocks), so the log showed "scouting up to 48 blocks" every 30 minutes. There is no exposed iron near home anyway, and safe mining (rightly) keeps it out of caves without armour. Without iron it can't make a bucket, so the farm agent can't get water on cold ground. It also lost a fight to three pillagers with a gear score of 17 of the 63 the ranged planner wants.

## What changes
- Needs: a search cut short (taken over or thrown in its first minute, or left at "started" by a restart) doesn't count towards `cooldownMinutes` or `perDay`; it may run again after `needs.search.retryMinutes` (5).
- `dig_mine` (progression skill): its own staircase mine near home. Entrance near home, dry, unprotected, unroofed, off farms, with 4 safe steps; a 1-wide, 2-high staircase at 45 degrees to `mine.depthY` (16); a main tunnel with branch pairs; ore in the walls and its vein (iron, coal, copper, diamonds with an iron pickaxe); torches, inline eating, pickaxe replacement, junk dropped at branch ends; back up on any limit (ore wanted, time, inventory, food, pickaxe, safe mining's underground retreat); remembered as a site (`mines`, site kind `mine`) and carried on next trip. Pure planner `src/skills/stairMinePlan.ts`. Settings `settings.mine` (`mine.*` toggles).
- Readiness for its own mine is separate from `mining.gear`: weapon, food, health, `mine.gear` (none by default), because a tunnel it digs never opens into a cave.
- The iron chain (`ironChain`): pickaxe, bucket, shield, chestplate, leggings, helmet, boots, then sword, axe, shovel; a blackboard need `bucket` puts the bucket first. Ingots wait for the next item while more iron is to be had. Worn armour and the offhand shield count. Planks are the last-resort fuel for any batch. The furnace goes by home and is remembered.
- keep_tools_upgraded `bucket` and `shield` options (default on); upgrade_tools `bucket` and `shield` params.
- The gear need: urgency counts a bucket (0.35, 0.6 with the `bucket` need) and a shield (0.3); its search tries exposed ore by day, then the mine, then smelts and crafts at home; it may run at night when a lit mine is known (`NeedSearch.night`).
- Survival bench results carry `endItems` and `mines`.

## Impact
New `src/skills/stairMinePlan.ts`, `src/skills/stairMine.ts`, `src/adapters/minecraft-java/needs/mine.ts`; changed `progression.ts`, `mining.ts` (exports), `needPlan.ts`, `behaviors/tools.ts`, `needs/index.ts`, `needs/sites.ts`, `brains/npc/needs.ts`, `core/needs.ts`, `core/toggles.ts`, `core/profile.ts` (settings.mine keys checked). Goldens: action catalogs and LLM tools (dig_mine, upgrade_tools bucket/shield).
