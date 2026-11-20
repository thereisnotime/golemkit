# Writing brains

A brain decides what the bot does. Skills say *what is possible*; brains pick *what happens
now*. A bot runs several brains at once and they share the body through
[priorities](../concepts/architecture#the-action-lock-and-priorities).

## The interface

```ts
import { defineBrain, PRIORITY } from '../core/index.ts'

export const sentry = (opts: { radius?: number } = {}) => defineBrain({
  name: 'sentry',
  start (agent) { },                     // once, when the agent starts
  session (agent, bot) {                 // every session (after spawn)
    const timer = setInterval(() => { ... }, 1000)
    return () => clearInterval(timer)    // cleanup when the session ends
  },
  stop (agent) { }                       // when the agent stops
})
```

Brains are factories so bots configure them (`sentry({ radius: 20 })`).

## Acting

Brains never drive mineflayer directly. They call actions:

```ts
const result = await agent.act('attack', { radius: 16 }, {
  caller: { kind: 'brain', name: 'sentry' },
  priority: PRIORITY.npc
})
if (!result.ok) agent.log.debug(`sentry: ${result.message}`)
```

This keeps the action lock authoritative: a player's `!stop` aborts whatever the brain
started, reflexes can interrupt it, and other brains know the body is busy.

| priority | value | typical caller |
|---|---|---|
| `idle` | 10 | ambient filler |
| `npc` | 20 | NPC routines |
| `llm` | 30 | LLM decisions |
| `player` | 50 | chat commands |
| `reflex` | 60 | self-defence, eating |
| `system` | 100 | boot scripts, admin |

- Higher priority preempts. A preempted `longRunning` action is resumed afterwards.
- Equal priority replaces the current action.
- Lower priority gets `{ ok: false, message: 'busy: ...' }`. Back off and try later rather
  than retrying in a tight loop.
- `agent.currentAction` tells you what's running and who started it.

## Listening

| source | |
|---|---|
| `agent.on('chat', msg)` | player chat and whispers (`msg.from`, `msg.message`, `msg.whisper`) |
| `agent.on('serverMessage', text)` | joins, deaths, advancements, system text |
| `agent.on('actionStart' \| 'actionEnd', ...)` | what the body is doing |
| `agent.on('session' \| 'sessionEnd', ...)` | connection lifecycle |
| `bot.on(...)` | anything mineflayer emits (register in `session`, remove in the cleanup) |
| `agent.fleet.subscribe(agent, fn)` | messages from other bots on the same server |

`agent.observe()` returns a JSON snapshot (position, health, food, time, nearby entities,
inventory, current action, plus whatever skills add). It's what an LLM brain sends to the
model, and handy for any decision logic.

## Talking

Always use `agent.say(text)`, `agent.whisper(player, text)` or `agent.reply(msg, text)`. They
are rate limited (vanilla kicks for chat spam) and split long text. Never call `bot.chat`.

## Example: a greeter

```ts
export const greeter = (greeting = 'welcome, {player}!') => defineBrain({
  name: 'greeter',
  session (agent, bot) {
    const seen = new Set(agent.storage.get<string[]>('greeted', []))
    const onJoin = (p: { username: string }) => {
      if (p.username === bot.username || seen.has(p.username)) return
      seen.add(p.username)
      agent.storage.set('greeted', [...seen])
      agent.say(greeting.replace('{player}', p.username))
      void agent.act('goto_player', { player: p.username }, { caller: { kind: 'brain', name: 'greeter' }, priority: PRIORITY.idle })
    }
    bot.on('playerJoined', onJoin)
    return () => bot.off('playerJoined', onJoin)
  }
})
```

## Coordinating several bots

Bots in the same fleet on the same server can message each other and share a blackboard. See
[Fleets and multiple servers](../concepts/architecture#fleets-and-multiple-servers).
