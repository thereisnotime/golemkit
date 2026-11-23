# pvp Specification

## Purpose
How far a bot goes against players (`combat.pvp`: off, defend, revenge, targets, all), who it never fights, how owners steer it (commands, intents, the kill switch), and how it fights a player (`combat.pvpTactics`). Policy in `src/skills/pvp.ts`, tactics in `src/skills/pvp-tactics.ts` (both pure), wiring in `pvp-actions.ts`, `pvp-fight.ts` and the reflexes.

## Requirements

### Requirement: Modes
`combat.pvp` SHALL be one of `off` (default), `defend`, `revenge`, `targets`, `all`, live-configurable and persisted. `off` never fights a player. `defend` only fights back (combat-techniques spec). `revenge` also attacks players with an active grudge. `targets` attacks players on `combat.targets` and grudges. `all` attacks every player within `combat.pvpEngage` blocks.

#### Scenario: Default
- **WHEN** nothing is configured
- **THEN** the mode is `off` and the bot never starts or answers a fight with a player

#### Scenario: Targets
- **WHEN** the mode is `targets`, Bob is on `combat.targets` and Carol is not
- **THEN** the bot attacks Bob on sight within range and leaves Carol alone

#### Scenario: All
- **WHEN** the mode is `all` and a stranger comes within 16 blocks and in sight
- **THEN** the bot attacks them, unless a safety rail applies

### Requirement: Safety rails
In every mode the bot SHALL NOT attack owners, players in `combat.friends`, players in creative or spectator, or itself, and SHALL NOT record grudges or targets for owners or friends. In the attacking modes, with `combat.spareProtected` on (default), it SHALL NOT attack a player standing in a protected area (learned protected zones, or within `world.spawnProtection` of the world spawn).

#### Scenario: Owner on the list
- **WHEN** an owner's name is on `combat.targets` or `attack_player` names an owner
- **THEN** the owner is never attacked and `attack_player` refuses

#### Scenario: Protected spawn
- **WHEN** the mode is `all` and a player stands inside spawn protection
- **THEN** the bot leaves them alone while `combat.spareProtected` is on

### Requirement: Revenge
In `revenge`, `targets` and `all`, the bot SHALL remember a player who killed or attacked the bot, an owner or the guarded player (a grudge), attack them on sight for `combat.revengeMinutes` (default 30), and forgive them after `combat.revengeKills` kills (default 1) or when the time runs out. Grudges SHALL be kept in storage and listed by `pvp_list`. A new grudge is whispered to the owners online.

#### Scenario: Killed
- **WHEN** Bob kills the bot with the mode `revenge`
- **THEN** after respawning the bot attacks Bob on sight for 30 minutes or until it killed him once

#### Scenario: Defend only
- **WHEN** the mode is `defend` and Bob attacks the bot
- **THEN** it fights back but keeps no grudge

### Requirement: Owner control and kill switch
Only owners (or the system) SHALL change the mode, add targets or start hunts (`pvp`, `attack_player`, `hunt_player`, `config_set`); LLM and NPC brains SHALL NOT. Anyone may make the bot more peaceful (`pvp off`, `spare_player`). `pvp off`, or `stop` from an owner, SHALL end every fight with a player and every hunt immediately; `stop` SHALL also switch an attacking mode to `off`. Mode changes SHALL be whispered to the owners online; the bot SHALL say nothing in public about PvP unless `combat.taunts` is on.

#### Scenario: pax stop
- **WHEN** the bot is hunting Bob in mode `targets` and an owner says "pax stop"
- **THEN** the hunt and the fight end at once and the mode becomes `off`

#### Scenario: LLM asks
- **WHEN** the LLM brain calls `attack_player`
- **THEN** it is refused

#### Scenario: Intents
- **WHEN** an owner says "pax attack Bob" and Bob is online
- **THEN** Bob is added to `combat.targets` and the mode becomes `targets`; "pax attack zombies" or a name that isn't online adds nobody

### Requirement: Engage, chase and give up
The reflexes SHALL engage an allowed player within `combat.pvpEngage` blocks (16) who is in sight or within 4 blocks, grudges before targets before anyone, nearest first. In `targets` and `all` (and `revenge` unless `combat.revengeIgnoresOdds`) a gear check SHALL skip fights whose duel odds are below `combat.pvpMinOdds` (0.7). A fight SHALL end past `combat.pvpChase` blocks (48) from its start, after `combat.pvpLostSec` seconds (30) out of sight, or after a pearl or teleport beyond half the chase limit; the player then waits a minute before the next engagement. `hunt_player` SHALL walk to the player's last known position and give up after `combat.huntMinutes` (10).

#### Scenario: Outgeared
- **WHEN** the mode is `all` and a player in full diamond with a sword comes close to a bot in leather
- **THEN** the bot does not start the fight

#### Scenario: Pearl away
- **WHEN** the enemy pearls 30 blocks away
- **THEN** the bot gives up instead of chasing

### Requirement: PvP tactics
With `combat.pvpTactics` on (default), fights with players SHALL use the PvP loop: sword on full charge with jump crits and a sprinted first hit; W-tap sprint hits when the enemy has a drop or lava behind or the bot is losing; the axe as main weapon against a player carrying a shield (a hit on a raised shield, charged or not, disables it for 5 s) and the sword otherwise; spacing of about 3 blocks while charging, circling, stepping back inside 2.4 blocks or, without a shield, when their swing is ready and ours is not; shield up for incoming arrows, a drawn bow, and in reach while our hit is more than 5 ticks from charged, down to hit; bow at 12 to 40 blocks with lead unless they block or close fast; a totem into the offhand at 10 health and a golden apple at 12; backing off to heal when low with nothing to heal and losing, coming back at 14 or 4 more than them; sidestepping when a drop or lava is behind. Off, the mob fight loop is used.

#### Scenario: Shield carrier
- **WHEN** the enemy carries a shield and the bot has an axe
- **THEN** it fights with the axe, and hits a raised shield at once so it is disabled for 5 s

#### Scenario: Ledge behind
- **WHEN** the bot stands with a 5-block drop behind it in a fight
- **THEN** it sidesteps before the next exchange instead of backing off the edge
