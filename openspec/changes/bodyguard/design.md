# Design

## Layers

- `src/skills/guard-plan.ts` is pure and unit-tested: it gets plain numbers (distances, line of
  sight, motion flags) and returns decisions.
- `src/skills/bodyguard.ts` reads the world into those numbers (`playerThreats`), runs the
  `protect` loop and keeps the per-agent escort state (`escorting`, `lastSeen`) that reflexes and
  `stay_safe` read.
- `src/brains/behaviors/library/bodyguard.ts` scores when to run `protect`, posts warnings from a
  per-tick hook (hooks run even while something else holds the body), and handles the player
  being out of sight or offline.

## Threats

A mob counts when it hurt the player (damage events carry the source entity, arrows report the
shooter; otherwise the nearest mob within 4 blocks), is a creeper within 6, an archer with a clear
line to the player within range, a phantom within 6 or diving (descending while closing in),
a melee mob within range that approaches or faces the player, anything within 5 of the player,
or something attacking the bot. Neutral mobs only when they attack. Ranking reuses
`tactics.threatScore` measured from the player, plus bonuses for hurting the player and closing
in; mobs that only bother the bot rank after everything that bothers the player. A creeper
within 6 of the player always stays first (300+).

## Fighting

`protect` calls `fightTarget` for the top threat with `maxChase = range`, under a watcher that
aborts the fight when a creeper comes within 6 of the player, the target leaves range + 6 of the
player, or the bot drifts too far. Outnumbered ends `protect` (the escape rules take over); low
health steps behind the player, eats, and goes on. Archers it couldn't reach for 3 s are blocked
for 20 s: stand on the line between them and the player behind a raised shield (when the line
can be covered: archers high up shoot down steeply, so the spot moves next to the player).

## Coordination

- Priority level `behavior` (35): above follow/guard_owner (npc, 20) and the LLM (30), below
  hooks, players and reflexes. Scores: 75 with a threat, 45 otherwise, 40 catching up, 22
  offline. `stay_safe` surrounded (92) and low health (88) still win.
- Reflexes keep self-defence (`defend`) when protect isn't running; while it is, they don't start
  defend over it, but retreat, the low-health back-off and gear/eat still run.
- `stay_safe` night/shelter are skipped while `escorting(agent)` is fresh (5 s, refreshed by the
  hook while the player is online).

## Feeding

Player health comes from entity metadata (index 9, `health`). Other players' hunger is never
sent by the server, so the decision uses health only and skips honestly when health isn't
visible either. It never gives away the bot's own reserve (`keepFood` items), feeds at most every
30 s, not with a threat close, and only within 5 blocks.
