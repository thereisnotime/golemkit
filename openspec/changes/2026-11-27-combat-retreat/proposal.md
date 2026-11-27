# Leave losing fights in time

## Why
Pax has 126 deaths, 62 of them in `defend`; the median health before the last hit was 1.7 and
every combat death in the last day was at 1 to 4 health. It has no armour and a stone sword. The
only rule that took it out of a fight was `combat.disengageToHeal` at 4 health or less, which
against two zombies is one exchange from dying, and it then backed off at walking pace.

## What changes
- A pure risk estimate (`src/skills/retreatPlan.ts`): damage of the threats in reach over the next
  `retreat.hits` attack cycles from a per-mob damage and cooldown table, approach time, the bot's
  armour, toughness, protection and shield and the difficulty. Leave when health would not
  survive it, with hysteresis; the 4-health rule stays as `retreat.floor`.
- Fight picking: with two of no armour, night and outnumbered, `defend` goes home or to a
  chokepoint instead of fighting in the open, unless an owner is in trouble.
- Escape routes as an ordered, configurable list (home and shut the door, pillar up, bunker,
  sprint away), each with a pure check; then eat, heal and come back when healthy.
- The log, the `defend` result and the status (`event`) say why it left and where it went.
- `settings.retreat` with a toggle per key; `retreat.enabled: false` is the old behaviour.
- guard-bench: `--time keep` is the default (no `/time set` on the shared server), `--duel mixed`,
  `--retreat on|off`, `--retreat-below`, escapes counted per duel.
