---
scope: mixed
scopeNote: "Definitions, brains and storage are game-agnostic; the skills and bot events are Minecraft."
---

# Writing a variant

A [variant](/concepts/variants-profiles) is a kind of bot: a file in `variants/` that default-exports `defineVariant(...)`,
saying which skills it has (what it can do) and which brains it runs (who decides). To run the
same variant with a different name, owner, model or server, write a
[profile](./profiles) instead; no code needed.

## The smallest useful bot

```ts
// variants/guard.ts
import { defineVariant } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'

export default defineVariant({
  name: 'guard',
  description: 'Follows its owner and kills hostile mobs',
  username: 'Guardian',
  skills: standardSkills(),
  brains: [commandBrain(), reflexes()],
  owners: ['Robin'],
  onSpawn: (agent) => {
    void agent.act('guard', { player: 'Robin' }, { caller: { kind: 'system', name: 'boot' } })
  }
})
```

```bash
just run guard
```

## Definition fields

| field | |
|---|---|
| `name` | id of the bot type |
| `description` | shown by `just bots` |
| `username` | default Minecraft username (override with `--username` or the [fleet file](/guide/running#a-fleet)) |
| `skills` | array of skills, e.g. `standardSkills()` or `[movement(), combat()]` |
| `brains` | array of brains; they run together, [priorities](/concepts/architecture#the-action-lock-and-priorities) decide who moves the bot |
| `persona` | personality/role text; LLM brains put it in their prompt |
| `owners` | players allowed to command it (empty = everyone, or `MC_OWNERS`) |
| `canDig` | let the pathfinder break blocks |
| `settings` | anything you want; read it with `agent.settings` (a [profile](./profiles) loaded on top warns about unknown keys in `settings.combat`, `mining`, `trips` and `inventoryMemory`) |
| `onSpawn(agent, bot)` | runs after every spawn |
| `adapter` | the game to play (an `AdapterFactory`); Minecraft Java by default |

## Picking skills

`standardSkills()` gives status, config, movement, combat, survival, inventory, gather, [journal](/guide/journal)
and bodyguard; `extendedSkills()` adds crafting, farming, food, building and the rest (see
[Skills](/skills)). Mix your own:

```ts
import { movement, combat, status } from '../src/skills/index.ts'
skills: [status(), movement(), combat()]
```

The [action reference](../reference/actions) lists every action per skill. `just actions <bot>`
prints what a specific bot ends up with.

## Picking brains

| brain | for |
|---|---|
| `commandBrain()` | player assistant: every action becomes a `!command` |
| `reflexes()` | fight back when hit (melee and ranged), eat when hungry, get away from danger; one referee keeps the reflexes from taking the body from each other |
| `behaviorsBrain()` | [armed behaviours](/guide/behaviors) such as keep_fed and stay_safe |
| `intentsBrain()` | plain-language owner commands without an LLM ([Intents](/guide/intents)) |

More brains (NPC loops, LLM agents, [scenes](/guide/scenes)) plug in the same way; see their guides.
A typical layering:

- **assistant**: `commandBrain()` + `reflexes()`
- **self-sufficient NPC**: [NPC brain](/guide/npc-brain) + `reflexes()` + `commandBrain()` (players can still
  take over)
- **LLM companion**: [LLM brain](/guide/llm-brain) + `reflexes()` + `commandBrain()` (so `!stop` always works)

## Settings and storage

```ts
settings: { home: [100, 64, -20], greeting: 'Welcome to the mine!' }
```

Read them anywhere you have the agent: `agent.settings.home`. For state that should survive
restarts use `agent.storage` (`get`, `set`, `delete`), a JSON file per bot under
`data/bots/<username>/`.

## Reacting to events

```ts
onSpawn: (agent, bot) => {
  agent.on('chat', (msg) => { if (msg.message.includes('treasure')) agent.say('where?!') })
  bot.on('playerJoined', (p) => agent.say(`welcome ${p.username}`))
}
```

For anything bigger than a few lines, write a [brain](./writing-brains) instead, so it's
reusable and gets session setup/cleanup right.
