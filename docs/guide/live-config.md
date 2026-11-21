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
| `reflexes.selfDefense` | on/off | fight back when hit |
| `reflexes.autoEat` | on/off | eat when hungry |
| `reflexes.eatBelow` | 0–20 | eat when food drops below this |
| `reflexes.retreatBelow` | 0–20 | back off at or below this health (0 = stand ground) |
| `reflexes.waterFightAbove` | 0–20 | don't fight mobs in water below this health (0 = always fight) |
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
| `retry.actions.<action>` | 0–10 | extra attempts after a failed action |

Behaviours have their own live commands: `!behavior_arm`, `!behavior_configure`,
`!behavior_disarm` (see [Behaviours](./behaviors)).

## How it works

```mermaid
flowchart LR
  P(["owner: !config_set llm.listen all"]) --> V{"known toggle?<br/>valid value?"}
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
