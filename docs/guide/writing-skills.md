# Writing skills

A skill is a group of related **actions**, plus optional per-session setup and observations.
Actions are the only way bots do things, so adding a capability means adding an action.

## An action

```ts
import { defineAction, z, ok, fail, goals, goto, playerEntity } from '../core/index.ts'

export const bringTorch = defineAction({
  name: 'bring_torch',
  description: 'Walk to a player and drop them a torch.',        // players and LLMs read this
  params: z.object({
    player: z.string().optional().describe('who gets it; default the requesting player')
  }),
  async run ({ bot, signal, player: caller }, { player }) {
    const who = player ?? caller
    const target = playerEntity(bot, who)
    if (!target) return fail(`can't see ${who}`)
    const torch = bot.inventory.items().find(i => i.name === 'torch')
    if (!torch) return fail('no torches')
    await goto(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), signal)
    await bot.toss(torch.type, null, 1)
    return ok(`gave ${who} a torch`)
  }
})
```

What you get for free:

- `!bring_torch Steve` works in chat (via `commandBrain`), `!help bring_torch` explains it.
- LLM brains see it as a tool with a JSON schema generated from the zod params.
- `agent.act('bring_torch', { player: 'Steve' })` from code, validated.
- It shows up in the [action reference](../reference/actions) after `just docs-gen`.

### The context

`run(ctx, params)` gets:

| `ctx.` | |
|---|---|
| `bot` | the mineflayer bot for this session |
| `agent` | the Agent (settings, storage, chat, [fleet](/concepts/architecture#fleets-and-multiple-servers), other actions) |
| `signal` | AbortSignal: fires on preemption, `!stop`, death or disconnect |
| `caller` | who asked: `{ kind: 'player' \| 'brain' \| 'reflex' \| 'system', name }` |
| `player` | the player behind the request, if any |
| `log` | logger scoped to the action |

### Flags

| flag | default | |
|---|---|---|
| `exclusive` | `true` | needs the body; takes the [action lock](/concepts/architecture#the-action-lock-and-priorities). Use `false` for queries and chat |
| `longRunning` | `false` | runs until stopped (follow, guard); resumed after being preempted |
| `aliases` | | extra command names |
| `internal` | `false` | hidden from `!help` and LLM tools (e.g. actions only [reflexes](/concepts/world#reflexes) use) |

### Honour the signal

Anything that takes time must stop when `signal` aborts, or `!stop` won't work and reflexes
can't take over. Use the helpers from core:

```ts
await goto(bot, goal, signal)          // pathfinding that stops on abort
await holdGoal(bot, goal, signal)      // dynamic goal until aborted (follow-style)
await sleep(500, signal)               // abortable wait
checkAborted(signal)                   // throw between steps of a loop
```

### Results

Return `ok(message, data?)`, `fail(message)`, a plain string (ok), or nothing ("done"). Keep
messages short; they go back to players in chat and to LLMs as tool results. An empty message
(`ok('')`) is not echoed in chat.

## A skill

```ts
import { defineSkill } from '../core/index.ts'

export const lighting = () => defineSkill({
  name: 'lighting',
  description: 'Torches and light.',
  actions: [bringTorch, placeTorch],
  plugins: [],                                   // mineflayer plugins, loaded once per session
  setup (agent, bot) {                           // every session, after spawn
    const onNight = () => { if (bot.time.timeOfDay > 13000) agent.log.debug('night falls') }
    bot.on('time', onNight)
    return () => bot.off('time', onNight)        // cleanup when the session ends
  },
  observe: (agent, bot) => ({                    // merged into agent.observe()
    torches: bot.inventory.items().filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0)
  })
})
```

Export the factory from `src/skills/index.ts` and use it in a bot. Skills are factories so
bots can pass options (`lighting({ minLight: 7 })`).

## Modded content

- Unknown block states are `modded_block`: solid, not diggable. Use `isModdedBlock(block)`.
- Unknown items are named `modded#<id>` by `itemName(item)`.
- Packets with modded item data may be skipped, so inventory and container contents can be
  incomplete. Code defensively.

## Testing

Pure logic goes in `test/*.test.ts` (`node --test`). To exercise an action against the real
server, drive an agent from a script; see `scripts/probe.ts`:

```ts
const agent = new Agent(defineVariant({ name: 't', skills: [lighting()], brains: [] }), serverFromEnv(), { username: 'TorchTest' })
agent.once('session', async () => {
  console.log(await agent.act('bring_torch', { player: 'Robin' }))
  await agent.stop()
})
void agent.start()
```
