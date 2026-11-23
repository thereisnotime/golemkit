---
scope: core
---

# Feature toggles (live config)

Some settings can be changed in game, while the bot runs, without a restart. Changes apply
immediately, survive restarts, and win over the [profile](/guide/profiles) until you reset them.

```
!config_list                          what can be changed, with current values (* = changed in game)
!config_get llm.listen                one setting and what it does
!config_set llm.listen all            change it (owners only)
!config_set reflexes.retreatBelow 6
!config_set retry.actions.goto 2
!config_reset llm.listen              back to the profile value
!config_reset                         undo every in-game change
```

Whispers work without the `!`. Only owners can change settings; LLM brains and other brains
can't change their own.

## What can be changed

| key | type | what |
|---|---|---|
| `canDig` | on/off | may break blocks and tunnel while pathing |
| `selfAware` | on/off | show the bot its own [variant](/concepts/variants-profiles), profile, model, brains and settings every turn (default on) |
| `respectBuilds` | on/off | leave blocks that look player-made alone when building (default off: the bot may dig and use anything it needs) |
| `reflexes.selfDefense` | on/off | fight back when hit (default on; also gates `combat.pvp defend`) |
| `reflexes.autoEat` | on/off | eat when hungry (default on) |
| `reflexes.eatBelow` | 0–20 | eat when food drops below this (default 15) |
| `reflexes.retreatBelow` | 0–20 | back off at or below this health (0 = stand ground; default 8) |
| `reflexes.waterFightAbove` | 0–20 | don't fight mobs in water below this health (0 = always fight; default 14) |
| `combat.adaptiveWeapon` | on/off | best weapon per target (damage × speed, enchantments, one-hit finishers, axe vs shields; default on) |
| `combat.ranged` | on/off | bow/crossbow for flyers and targets out of reach, if it has arrows (default on) |
| `combat.shield` | on/off | raise a shield against ranged mobs between swings (default on) |
| `combat.crits` | on/off | jump and hit while falling for critical hits (×1.5), sprint into the first hit for knockback (default on) |
| `combat.strafe` | on/off | keep spacing and circle melee mobs between swings, step back after a hit (default on) |
| `combat.disengageToHeal` | on/off | at 4 health or less with food, back off briefly to eat and fight on; works with `retreatBelow 0` (default on) |
| `combat.autoArmor` | on/off | wear the best armour in the inventory, shield or totem in the offhand (default on) |
| `combat.maxChase` | 2–64 | stop chasing a mob this many blocks from where the fight started (default 16) |
| `combat.sprintReset` | on/off | W-tap: sprint into ground hits for knockback when a crit isn't possible or knockback is worth more (default on) |
| `combat.sweep` | on/off | with a sword, plain ground hits when mobs bunch around the target, so the sweep hits them all (default on) |
| `combat.shieldMelee` | on/off | shield up against melee mobs between slow swings, and against a lit creeper it can't outrun; an axe hit is blocked, then the shield is down 5 s (default on) |
| `combat.totem` | on/off | totem of undying into the offhand at 8 health or less, or in a fall that could kill; it stays there until health is above 14 (default on) |
| `combat.goldenApple` | on/off | eat a golden apple mid-fight at 8 health or less, 12 when surrounded (default on) |
| `combat.waterClutch` | on/off | water bucket against fall damage and to put out fire, scooped back up (default on) |
| `combat.endermanGaze` | on/off | never look an enderman in the eyes unless fighting it (default on) |
| `combat.fightFastMobs` | on/off | at low health keep fighting mobs faster than the bot (vindicators, ravagers, spiders, wolves, piglin brutes, hoglins) instead of backing off (default on) |
| `combat.chokepoints` | on/off | against 3+ melee mobs with half health or more, fight from a 1-wide gap nearby (default on) |
| `combat.pvp` | off / defend | `defend`: fight back a player who attacks the bot or the player it guards, stop when they stop or run; never owners or friends (default off) |
| `combat.friends` | names | players never fought back, even with `combat.pvp defend` (comma separated) |
| `humanize.enabled` | on/off | player-like reaction and typing delays |
| `humanize.typoRate` | 0–1 | chance of a typo per message |
| `humanize.lowercase` | on/off | write chat in lower case |
| `humanize.pauseWhileTyping` | on/off | stand still while typing |
| `humanize.idleFidget` | on/off | look around when idle |
| `llm.listen` | mention / conversation / all | how it follows chat |
| `llm.immersive` | on/off | stay in character (reports stay truthful) |
| `llm.conversationMs` | ms | how long follow-ups don't need its name |
| `llm.aliases` | list | other names it answers to (`pax,p`) |
| `llm.budget.turnsPerHour` / `tokensPerHour` / `tokensPerDay` | number | LLM budgets |
| `llm.budget.maxToolCalls` | number | tool calls per turn |
| `llm.goals.maxTurns` / `timeoutMin` | number | how long goals run on their own |
| `llm.goals.ownerWaitMin` | minutes | after asking the owner, go on alone if no answer (0 = wait forever; default 15) |
| `intents.mode` | fallback / first / off | [plain-language commands](/guide/intents) without the LLM: only while it's down, simple requests always, or never (see [plain-language commands](./intents)) |
| `intents.strategy` | first_confident / vote / best | how the [intent layers](./intents#layer-pipeline) pick a winner: the first one above its threshold, the intent most confident layers agree on, or the highest confidence |
| `intents.log_decisions` | on/off | one debug line per message with each layer's guess, confidence and time |
| `intents.layers.patterns.enabled` / `.threshold` | on/off, 0–1 | the pattern parser layer (default on, 0.7) |
| `intents.layers.embeddings.enabled` / `.threshold` | on/off, 0–1 | the local embedding model layer (default 0.62); switching it on adds it after patterns on a bot without layer config; a threshold change keeps the loaded model |
| `intents.layers.local_llm.enabled` / `.threshold` | on/off, 0–1 | the local LLM layer (needs `url` and `model` in the profile; default 0.7) |
| `intents.layers.cloud_llm.enabled` | on/off | hand lines no layer understood to the [LLM brain](/guide/llm-brain) (off: they're dropped in mode `first`) |
| `pathfinder.thinkTimeoutMs` | 1000–60000 | how long the pathfinder may plan one path (default 10000); raise on a loaded machine, see [tool progression](./progression#speed) |
| `building` | library / creative / ask | reuse a saved [blueprint](/guide/goals-and-building#blueprint-format), design a new one, or let the owner pick (see [Blueprint libraries](./blueprints#building-policy)) |
| `build.creativeMethod` | auto / hand / commands | how a creative bot builds: hand = block by block like a player (auto means hand), commands = `/fill` and `/setblock` when it is op (each command shows to other ops as an admin message); survival always builds by hand (see [creative builds](./goals-and-building#creative-mode)) |
| `build.handDelayMs` | 0–5000 | pause after each block in a creative hand build (default 150, jittered ±50) |
| `road.width` | 1–5 | lanes of a new [road](./roads.md) (even widths round up; default 3) |
| `road.palette` | stone_bricks / cobblestone / stone / oak / spruce | what roads are made of (default stone_bricks: stone brick floor and stairs, cobblestone base, stone brick wall railings) |
| `road.maxCut` / `road.maxFill` | 0–16 / 0–24 | deepest cut into the ground and highest fill above it for any lane (default 6 / 6) |
| `road.lanterns` | on/off | lanterns on posts at road landings (default off) |
| `worldedit.enabled` | on/off | WorldEdit actions: on = the server has it (no detection), off = never; reset = detect (see [WorldEdit](./worldedit.md)) |
| `worldedit.maxBlocks` | number | largest region a WorldEdit action may change (default 50000) |
| `retry.actions.<action>` | 0–10 | extra attempts after a failed action |

In a profile, the `reflexes.*` values go under `reflexes:` and the `combat.*` values under
`settings: combat:` (a top-level `combat:` key is ignored); see
[Reflexes](/concepts/world#reflexes). The techniques behind the `combat.*` toggles are described
in [Movement, protection and combat](/concepts/world#skilled-player-techniques).

Behaviours have their own live commands: `!behavior_arm`, `!behavior_configure`,
`!behavior_disarm` (see [Behaviours](./behaviors)).

## How it works

```mermaid
flowchart TD
  P(["owner: !config_set<br/>llm.listen all"]) --> V{"known toggle?<br/>valid value?"}
  V -- no --> E(["error: what's allowed"])
  V -- yes --> S[("agent.storage<br/>settings.overrides")]
  S --> M["effective settings =<br/>profile ⊕ overrides"]
  M --> R["reflexes read it<br/>on every event"]
  M --> L["LLM brain:<br/>applySettings()"]
  M --> H["humanize, retry,<br/>canDig recomputed"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class P a
  class V d
  class S,M,R,L,H g
  class E r
```

From code: `agent.setToggle(key, value)`, `agent.resetToggle(key?)`, `agent.listToggles()`, and the
`settingsChanged` event. Add new toggles in `src/core/toggles.ts` (a key, a description, a zod
schema) and make the consumer read `agent.settings` when it acts, not once at startup.
