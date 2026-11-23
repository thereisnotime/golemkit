---
scope: mixed
scopeNote: "The action lock, brains, chat queue and fleets are game-agnostic; the Minecraft Java adapter wraps a Mineflayer bot and its NeoForge platform hooks the client."
---

# Architecture

```
variants/<name>.ts      what kind of bot: skills + brains + default persona/settings
profiles/<name>.yaml    a saved instance: variant + username, owners, server, LLM, settings
fleets/<name>.yaml      profiles/variants run together, possibly on several servers
src/brains/             who decides: command (chat), npc, llm, intents, behaviours, scenes, ...
src/skills/             what it can do: actions grouped by topic (Minecraft)
src/core/               agent lifecycle, action lock, chat, storage, the GameAdapter interface
src/adapters/           games: minecraft-java (Mineflayer, reflexes, behaviour library,
                        server platforms in platforms/: neoforge, vanilla, paper)
```

## The big picture

```mermaid
flowchart TB
  CLI["just run / just fleet"]
  CLI --> PROF["profiles/*.yaml"] & FLEET["fleets/*.yaml"]
  AG["One Node process: a Fleet<br/>Agent (one per bot)<br/>brains · skills<br/>action lock · chat · storage"]
  BUS["Fleet bus +<br/>blackboard<br/>(per server)"]
  PROF & FLEET --> AG
  AG <-.->|"brains"| BUS
  AG -->|"skills,<br/>chat queue"| MF["Minecraft Java adapter<br/>Mineflayer + pathfinder"]
  AG -.->|"llm / self brains<br/>(proxy optional)"| LLM["LLM providers<br/>Claude · Codex<br/>OpenCode · API"]
  MF --> NF["Server platform<br/>NeoForge: handshake · registries<br/>tolerant parser<br/>(or vanilla · Paper)"]
  NF --> SRV[("Minecraft server<br/>NeoForge 1.21.1 · vanilla · Paper")]
  classDef run fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef brain fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  classDef lock fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef skill fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef lib fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef ext fill:#fef3c7,stroke:#d97706,color:#78350f
  class CLI,PROF,FLEET run
  class AG brain
  class BUS skill
  class MF,NF lib
  class LLM,SRV ext
```

Inside one agent:

```mermaid
flowchart TB
  CTX["Context pack<br/>AGENTS · USER · MEMORY<br/>skills · hooks"]
  CTX -.-> BR["Brains<br/>command · reflexes · hooks<br/>npc · scene · llm · self"]
  BR -->|"agent.act()"| LOCK{{"Action lock<br/>priorities · retries"}}
  BR --> CHAT["Chat queue<br/>rate limit · humanize"]
  LOCK --> SK["Skills → actions<br/>movement/travel · combat<br/>crafting · farming<br/>journal · ..."]
  SK -.-> PA[("Protected areas<br/>per server")]
  ST[("Storage + journal<br/>data/bots/…")]
  CHAT ~~~ ST
  SK --> MF["Game adapter<br/>Mineflayer + pathfinder"]
  CHAT --> MF
  classDef run fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef brain fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  classDef lock fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef skill fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef lib fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef ext fill:#fef3c7,stroke:#d97706,color:#78350f
  class BR,CHAT,CTX brain
  class LOCK lock
  class SK,ST,PA skill
  class MF lib
```

Brains decide, skills provide actions, the action lock arbitrates the body, the
[game adapter](./adapters.md) is the game, and its server platform (NeoForge by default,
`MC_PLATFORM` picks vanilla or Paper) gets everything into the server. [Variants](/concepts/variants-profiles) pick skills and brains; [profiles](/guide/profiles) and
fleets pick who, where and how many.

## Agent

`Agent` (src/core/agent.ts) is one bot identity. It survives disconnects: every reconnect is
a new *session* (with Minecraft Java, a fresh mineflayer `Bot` from the adapter), and
skills/brains get their `setup()` / `session()` hooks called again. The game is behind
`agent.adapter` (see [Game adapters](./adapters.md)); brains read it there, Minecraft skills
get the bot as `ctx.bot`. The agent owns:

- the action registry and the **action lock** (`act()`), with [retries](../guide/profiles#retries)
- rate-limited chat (`say`, `whisper`, `reply`), since vanilla kicks for spam, optionally
  [humanized](../guide/profiles#humanize-player-like-timing)
- persistent storage (`agent.storage`, JSON under `data/bots/<username>/`)
- the [event journal](../guide/journal) (`agent.journal`, JSONL under `data/bots/<username>/journal/`): typed facts about what happened, with rollups
- learned [protected areas](./world#protected-areas) (`agent.protectedAreas`) per server
- `observe()`: a JSON snapshot of the bot and surroundings, extended by skills and brains
- events: `session`, `sessionEnd`, `chat`, `serverMessage`, `actionStart`, `actionEnd`, `llmUsage`, `chatOut`, `protectedArea`, `stopped`, `settingsChanged`, `gameModeChanged`

The negotiating step is the NeoForge platform's handshake; on vanilla and Paper the bot goes
straight from login to configuration.

```mermaid
stateDiagram-v2
  [*] --> Connecting: start()
  Connecting --> Negotiating: login
  Negotiating --> Connecting: rejected,<br/>learned channels<br/>(retry in 4.5 s)
  Negotiating --> Configuring: channel list<br/>accepted
  Configuring --> Playing: spawn (skills setup,<br/>brains session)
  Playing --> Waiting: kicked / disconnected<br/>/ server restart
  Waiting --> Connecting: after<br/>MC_RECONNECT_DELAY_MS
  Playing --> [*]: stop()
  note right of Playing
    actions run, brains decide,
    chat flows, storage persists
  end note
```

## Actions

Everything a bot does is an action, defined with `defineAction`:

```ts
const follow = defineAction({
  name: 'follow',
  description: 'Follow a player until stopped.',          // shown in !help and to LLMs
  params: z.object({ player: z.string().optional() }),    // validation + types + tool schema
  longRunning: true,                                      // resumes after being preempted
  async run ({ bot, signal, player: caller }, { player }) {
    ...                                                   // must honour `signal`
    return ok('stopped following')
  }
})
```

- `exclusive` (default true): needs the body and takes the action lock. Set false for
  queries/chat that can run alongside.
- `longRunning`: runs until aborted (follow, guard).
- `internal`: hidden from `!help` and LLM tool lists.
- `capabilities`: what the game must support (`dig`, `place`, `move`, ...; a skill can set a
  default). Agents on a game without one don't get the action at all.
- `run()` returns `ok(msg, data?)`, `fail(msg)`, a string, or nothing.
- Use `goto(bot, goal, signal)`, `holdGoal`, `sleep(ms, signal)`, `checkAborted(signal)` from
  core so actions stop promptly.

### The action lock and priorities

Only one exclusive action runs at a time. Callers have priorities (`PRIORITY` in action.ts):

| caller | priority |
|---|---|
| idle | 10 |
| npc | 20 |
| [scene](/guide/scenes) | 25 |
| llm | 30 |
| behavior (armed survival behaviours) | 35 |
| hooks (`HOOK_PRIORITY` in src/context/hooks.ts) | 40 |
| player | 50 |
| reflex | 60 |
| system | 100 |

A call with higher priority preempts the current action; if that one is `longRunning` it is
suspended and resumed afterwards (a reflex fights a zombie, then the bot goes back to
following you). Equal priority replaces. Lower priority is rejected with `busy: ...`.
`stopActions()` aborts everything and clears the suspended stack.

```mermaid
%%{init: {"sequence": {"width": 95, "actorMargin": 10}}}%%
sequenceDiagram
  autonumber
  participant P as Player<br/>(prio 50)
  participant R as Reflexes<br/>(prio 60)
  participant L as Action lock
  participant B as Body
  P->>L: act follow<br/>(longRunning)
  L->>B: follow Robin
  Note over B: zombie hits<br/>the bot
  R->>L: act defend
  L-->>B: suspend follow<br/>(preempted)
  L->>B: defend
  B-->>L: zombie dead
  L->>B: resume follow
  participant N as NPC brain<br/>(prio 20)
  N->>L: act wander
  L-->>N: busy: follow<br/>(player)
```
 `cancelActions(match)` aborts
and drops only the actions matching a predicate (a scene uses it to stop exactly what it
started).

## Skills

```ts
export const farming = () => defineSkill({
  name: 'farming',
  actions: [harvest, plant],
  plugins: [somePlugin],                   // mineflayer plugins, loaded once per session
  setup (agent, bot) { ...; return cleanup }, // per session
  observe (agent, bot) { return { cropsNearby: 12 } }
})
```

Skills are factories so a bot can pass options. `standardSkills()` bundles the common ones.

## Brains

```ts
export const myBrain = (opts) => defineBrain({
  name: 'my-brain',
  start (agent) { agent.on('chat', ...) },        // once
  session (agent, bot) { ...; return cleanup },   // every session
  observe (agent, bot) { return { mood: 'ok' } }, // optional, merged into agent.observe()
  stop (agent) { ... }
})
```

Brains call `agent.act(name, params, { caller: { kind: 'brain', name }, priority })`.
Several brains run at once and negotiate through priorities. Shipped:

- `commandBrain()` maps chat to actions: every action is a command; positional args in schema
  order, `key=value` works, last string param takes the rest of the line.
- `reflexes()` (`src/adapters/minecraft-java/brains/reflexes.ts`) handles self-defence, ranged
  defence, auto-eat, armour and totem swaps and the water clutch at reflex priority.
- `hooksBrain()` runs the context pack's [hooks.yaml](/guide/context-pack#hooks-yaml):
  event-to-action rules without an LLM, at priority 40.
- `intentsBrain()` turns plain-language owner commands into actions without an LLM; next to an
  LLM brain it fills in while the model can't think or takes the simple requests itself. See
  [Intents](../guide/intents.md).
- `behaviorsBrain()` runs [armed behaviours](/guide/behaviors) (keep_fed, stay_safe, follow_owner...) that owners,
  LLMs and hooks switch on at runtime. See [Behaviours](../guide/behaviors.md).
- `npcBrain()` keeps NPCs busy on their own: scored behaviours at npc priority, backs off for
  players, LLMs and [reflexes](/concepts/world#reflexes). See [NPC brain](../guide/npc-brain.md).
- `sceneBrain()` lets several bots act out scenes together (see [Scenes](../guide/scenes.md)).
- `llmBrain()` lets a language model drive the bot at llm priority, through the same actions
  (as tools, also over MCP). See [LLM brain](../guide/llm-brain.md).
- `selfImprover()` runs a declarative program through the NPC controller and rewrites it with
  one LLM call when an owner teaches it. See [Self-improver](../guide/self-improver.md).

## Bots

```ts
export default defineVariant({
  name: 'buddy',
  username: 'McBuddy',
  skills: standardSkills(),
  brains: [commandBrain(), reflexes()],
  persona: 'cheerful helper',   // for LLM brains
  settings: { home: [0, 64, 0] }
})
```

Run with `node src/cli.ts run <bot>`, or many at once with a [fleet file](/guide/running#a-fleet) (see
`fleets/example.yaml`). Instance overrides (username, owners, canDig, settings) come from CLI
flags or the fleet file.

## Fleets and multiple servers

Every running agent belongs to a `Fleet` (a fleet of one for `run`). A fleet file can list
several `servers`; each bot entry picks one (`defaults.server` otherwise), logins are
staggered per server and servers start in parallel. When the same username runs on more than
one server, its data goes to `data/bots/<server>/<username>`.

Coordination between bots on the same server (messages never cross servers):

```ts
const fleet = agent.fleet
fleet.peers(agent)                                         // other bots on this server
fleet.send({ from: agent.username, server: agent.serverName, topic: 'cart-broken', to: 'Miner1' })
fleet.subscribe(agent, msg => { ... })                     // addressed to me or broadcast
await fleet.waitFor(agent, m => m.topic === 'ready', 30_000, signal)
const board = fleet.board(agent.serverName)                // shared blackboard per server
board.set('scene', 'act2'); board.watch('scene', v => ...)
```

## NeoForge layer

See README "How it gets in". It lives in `src/adapters/minecraft-java/platforms/neoforge/`, the
default server platform of the Minecraft Java adapter, and is transparent to skills.
Modded blocks are `modded_block` (solid), modded items are `modded#<id>`.
