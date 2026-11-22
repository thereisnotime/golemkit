# Guard intercept

## Why

The mob-wave benchmark (`just guard-bench`) shows the bodyguard cuts hits on its owner by about a
third, but it only reacts once mobs reach the player: the first hit lands 4 to 5 s after a wave
spawns, the bot fights one mob while others hit the player, and it dies to creepers it fights
point blank without armour.

## What changes

- Intercept: engage hostiles heading for the player while they are still 6 to 12 blocks out.
- Pull aggro: hit a mob near the player and back away so it follows the bot.
- Creeper tactics: shoot with a bow when available, otherwise hit once and step back; never stay
  within 3 blocks of a lit fuse.
- Gear up when armed: run `gear_up` (armour, shield, best weapon) when the bodyguard is switched
  on and after each death.

## Status

Proposed, not started.
