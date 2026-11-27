# Dodging in mob fights

## Why
Pax has 126 deaths: 38 shot (34 skeleton, 3 pillager, 1 stray), 42 melee (31 zombie) and 11
creeper. The fight loop only uses sprint and jump to attack (sprint-in, W-tap, crit jumps). Its
defence is a walking strafe flipped on a random timer, a 350 ms walk back after each hit and a
zig-zag on the way to an archer. It never looks at an arrow, doesn't know when a zombie can
swing again, and walks away from a lit creeper.

## What changes
- A dodge layer (`src/skills/dodgePlan.ts` pure, `src/skills/dodge.ts` glue) that owns movement
  during a fight, called once per tick from the movement part of `fightTarget`. Its per-tick
  techniques are a list (`DODGE_TECHNIQUES`), each with its own switch:
  - draws: leap sideways a tick before a close skeleton releases its drawn bow (20 ticks), juke
    while a pillager holds a charged crossbow;
  - arrows: ballistic check of each projectile in flight against the bot's box, leap to a side
    that clears it in time;
  - melee timing: each melee mob's attack cooldown from its swings and the hits it lands; hold
    ground while it recharges, be out of its axis-aligned reach before it can swing again.
- The leap: face the dodge direction, sprint-jump, snap back to the target after `leapMs`. Each
  leap is checked along its path and where it lands (walls, water, lava, fire, powder snow,
  harmful blocks, drops deeper than `maxDrop`). The side is picked at random between equal sides,
  never three times the same way, fewer mobs first.
- Creeper leap: `creeperMove` returns `leap` instead of `back_off` when the layer has it, and the
  bot sprint-jumps away; `creeperEscape` takes the faster gain into account. Off by default:
  in the bench it cost kills without saving health.
- `ranged_defense` walks to cover and out of range stop for an arrow or draw leap.
- Leaps don't count towards `maxChase` in `fightTarget`.
- Settings `settings.combat.dodge` (`false` or an object), all live as `combat.dodge.*`.
- Fight results and `defend` report `dodges` and `arrowsDodged`.
- `guard-bench`: `--time keep` (new default, never sets the time), `--wait-day`, `--dodge on,off`
  variants for duels, a `mixed` duel (zombie, skeleton, creeper), dodge counters in results.

## Out of scope
When to leave a fight (disengage to heal, escape routes): the combat-retreat change.
