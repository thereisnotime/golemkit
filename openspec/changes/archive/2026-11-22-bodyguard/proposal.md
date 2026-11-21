# Bodyguard

## Why

Owners ask bots to "guard me", and the existing `guard_owner` behaviour only fights the hostile
mob nearest to the player with the old `guard` action: no threat ranking, no archers, no
warnings, and at night `stay_safe` walks the bot home and leaves the player alone. A real
bodyguard has to protect its owner without an LLM turn for every mob.

## What changes

- New `bodyguard` behaviour (priority level `behavior`, armed off in Pax's profile until an owner
  turns it on) with options `player`, `distance`, `range`, `feed`, `keepFood`, `warn`, `chat`,
  `whisper`, `whenGone`, `catchUp`.
- New `bodyguard` skill with the `protect` action (the guarding loop on top of the existing fight
  loop) and `feed_player` (toss food to a player).
- Pure planning module `guard-plan.ts`: threats to the player and their ranking, the spot between
  the player and a threat, the spot that blocks an archer's line of fire, the feed decision,
  warning texts and their rate limit.
- `tactics.attackRefusal`: the never-attack rule as a pure function; `combatRefusal` uses it and
  can count attacks on the protected player.
- `stay_safe` doesn't go home or dig in at night while a bodyguard escorts an online player.
- Reflexes leave target picking to `protect` while it holds the body (they still retreat and
  back off to heal), and don't bunker away from the player unless health is 6 or less.
- Live benchmark `scripts/guard-test.ts`.
