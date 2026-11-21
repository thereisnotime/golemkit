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

## Found in live runs

- A creeper walking up while the bot fought a zombie blew it up in full iron: the loop now ends
  the fight (`retarget`) when a creeper comes within 5 blocks of a bot fighting something else.
- Repeated `defend` runs each measured the chase from their own start, so the bot drifted down a
  hillside 30 blocks: the chase is now measured from an anchor that lives until 20 s without a
  fight, and `defend` walks back to it afterwards.
- After a respawn the hurt event for our own entity went missing once (5 s idle while hit): a
  health drop now triggers the same reflex.
- Exploding creepers were counted as kills: a kill needs the death animation (entityDead).
- At full hunger bread can't be eaten, so the heal back-off also applies at food >= 18, where
  natural regeneration does the healing.
- A shield already in the offhand wasn't found (`inventory.items()` skips slot 45).
