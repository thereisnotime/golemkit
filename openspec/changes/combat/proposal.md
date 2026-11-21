# Better fighting

## Why

Pax dies every few minutes at night to zombies, skeletons, creepers and spiders. The fight loop
swung on a fixed 600 ms timer, stood still between swings, chased archers far from shelter,
never wore the iron armour it crafted, and with `retreatBelow: 0` it fought on at one heart even
with food in its pocket.

## What changes

- Fight loop (`src/skills/fight.ts`, pure decisions in `src/skills/tactics.ts`): swings on the
  held weapon's real attack cooldown, jumps for critical hits, sprints into the first hit, checks
  reach from the eyes to the hitbox, keeps spacing and strafes, steps back after a hit, closes
  on archers in a zig-zag or behind a shield, waits for spiders on flat ground, doesn't follow
  mobs into water, lava, drops or dark caves, and gives up a chase `combat.maxChase` blocks from
  where the fight started.
- Targets: `defend` fights everything around in threat order (close creeper, archer in sight,
  nearest melee), never players, villagers, golems, pets or named mobs, and neutral mobs only
  while they attack. Outnumbered (3+ melee mobs, under half health): pillar 2 blocks and hit from
  the top, or go home, or back off.
- Gear: new `gear_up` action and reflex (`combat.autoArmor`): wear the best armour, shield or
  totem in the offhand. Bow aim uses arrow physics and the target's measured velocity.
- Sustain: eat in lulls when hunger blocks regeneration; `combat.disengageToHeal` backs off to
  eat at 4 health or less when there is food, then re-engages (independent of `retreatBelow`).
- Night: `stay_safe` goes home earlier when the bot has no armour, weapon or food, and without a
  home digs in (`bunker`) for the night.
- New toggles `combat.crits`, `combat.strafe`, `combat.disengageToHeal`, `combat.autoArmor`,
  `combat.maxChase`.
- `scripts/fight-test.ts` measures kills and deaths over a night on the live server.

## Non-goals

- No mineflayer-pvp (it pins an old mineflayer).
- No cover-seeking pathing against archers; zig-zag, shield and backing out of the line of fire.
- Core: only the toggle list changes.
