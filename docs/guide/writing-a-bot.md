# Writing a bot

A bot is a file in `bots/` that default-exports `defineBot(...)`: which skills it has (what it
can do) and which brains it runs (who decides).

## The smallest useful bot

```ts
// bots/guard.ts
import { defineBot } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'

export default defineBot({
  name: 'guard',
  description: 'Follows its owner and kills hostile mobs',
  username: 'Guardian',
  skills: standardSkills(),
  brains: [commandBrain(), reflexes()],
  owners: ['robin'],
  onSpawn: (agent) => {
    void agent.act('guard', { player: 'robin' }, { caller: { kind: 'system', name: 'boot' } })
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
| `username` | default Minecraft username (override with `--username` or the fleet file) |
| `skills` | array of skills, e.g. `standardSkills()` or `[movement(), combat()]` |
| `brains` | array of brains; they run together, priorities decide who moves the bot |
| `persona` | personality/role text; LLM brains put it in their prompt |
| `owners` | players allowed to command it (empty = everyone, or `MC_OWNERS`) |
| `canDig` | let the pathfinder break blocks |
| `settings` | anything you want; read it with `agent.settings` |
| `onSpawn(agent, bot)` | runs after every spawn |

## Picking skills

`standardSkills()` gives status, movement, combat, survival, inventory and gather. Mix your
own:

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
| `reflexes()` | fight back when hit, eat when hungry |

More brains (NPC loops, LLM agents, scenes) plug in the same way; see their guides.
A typical layering:

- **assistant**: `commandBrain()` + `reflexes()`
- **self-sufficient NPC**: NPC brain + `reflexes()` + `commandBrain()` (players can still
  take over)
- **LLM companion**: LLM brain + `reflexes()` + `commandBrain()` (so `!stop` always works)

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
