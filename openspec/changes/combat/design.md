# Design

## Split

- `tactics.ts` is pure: `attackCooldownMs`, `swingDecision`, `threatScore`/`rankTargets`,
  `outnumbered`, `shouldDisengageToHeal`, `shouldEatInLull`, `pickArmor`, `pickOffhand`,
  `aimArrow`, `spacing`, `chaseRefusal`, `unpreparedForNight`. All unit-tested.
- `fight.ts` runs one fight at 50 ms ticks and returns why it ended (`killed`, `escaped`,
  `timeout`, `gave_up`, `heal`, `outnumbered`). It never decides what happens next.
- `combat.ts` actions pick targets and react to the end: `defend` loops over threats, backs off to
  eat on `heal`, escapes on `outnumbered`, backs out of an archer's line of fire on `gave_up`.

## Timing

Cooldown = 1000 / attack speed ms (sword 625, stone axe 1250). Switching the held item resets the
server's charge, so the loop restarts its timer whenever `equipForTarget` changes the item.
Crits need falling, not sprinting, not in liquid and a full charge: the bot jumps when the
cooldown has <= 300 ms left (a jump peaks after ~6 ticks) and swings once it is falling and
charged. The first hit of a fight is a sprint hit for knockback instead.

## Movement

Within reach the pathfinder goal is cleared and the loop drives control states directly. Every
step is checked (`safeStep`): no liquid or fire, no drop over 2 blocks. Spacing: horizontal
distance < 2.2 back, > 2.9 forward, otherwise strafe, flipping direction every 0.7-1.4 s or at an
unsafe edge. Further away the pathfinder follows, except for a straight, level approach within
6 blocks (12 for archers), which is steered directly so the first hit lands sprinting.

## Disengaging

`retreatBelow` stays Pax's choice. `disengageToHeal` only applies with something edible now
(normal food needs hunger < 20, golden apples always work), backs off ~10 blocks for <= 5 s,
eats (a golden apple first when health <= 10), and fights on. At most 3 times per `defend`.
Outnumbered uses a 2-block pillar: zombie attack boxes inflate horizontally only, so they can't
reach feet 2 blocks up, while the bot reaches their heads.

## Gear

`gear_up` is non-exclusive (inventory clicks only) and refuses while a window is open. The
reflexes timer runs it when `gearPlan` finds an upgrade, at most every 10 s. Offhand: totem when
health <= 10 or there is no shield, else shield.

## Alternatives

mineflayer-pvp: pinned to an old mineflayer and has no crits or spacing. A separate brain for
combat: would fight reflexes over the body; keeping it inside `defend` keeps one owner.
