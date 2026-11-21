# NPC brain

`npcBrain()` (src/brains/npc/) makes a bot live on its own: wander near home, go back at
night, sleep, eat, deal with mobs, notice players, do chores when it has the skills. It is a
utility-AI loop you configure with behaviours. `variants/villager.ts` is the worked example. For brains in general see [Writing brains](writing-brains.md).

```ts
import { npcBrain, wander, goHome, sleepAtNight, fleeOrFight, actionBehavior } from '../src/brains/npc/index.ts'

brains: [
  commandBrain(),          // players can still command it (player priority beats npc)
  reflexes(),              // fight back when hit, eat
  npcBrain({
    behaviors: [fleeOrFight(), sleepAtNight(), goHome(), wander({ radius: 12 })],
    hooks: [greetPlayers({ chance: 0.3 })]
  })
]
```

Add `navigation()` to the skills: most built-in behaviours use its actions (`wander`,
`go_home`, `flee`).

## How a tick works

Every `tickMs` (1.5 s) the brain:

1. refreshes the **[blackboard](/concepts/architecture#fleets-and-multiple-servers)** from the bot (needs and facts, below)
2. runs the **hooks** (cheap per-tick functions that don't need the body)
3. checks `agent.currentAction`: if a player, LLM, reflex or system caller holds the body at
   npc priority or above, it aborts its own behaviour and **backs off** (player/brain 20 s,
   reflex 3 s, system 10 s, configurable via `backoffMs`). The back-off is extended every
   tick while they hold it, so the NPC waits until they are done plus the back-off.
4. **scores** every behaviour, then `decide()` picks:
   - nothing running: start the best positive score
   - running behaviour now scores 0: switch to the best, or stop
   - a challenger beats the running score by `switchMargin` (10) and the running behaviour
     has had `minRunMs` (3 s), or the challenger scores at least `urgentScore` (80): switch
   - otherwise keep going

When it switches, the old behaviour's `signal` aborts and the brain replaces its in-flight
action with the internal no-op `npc_interrupt`, so the body stops right away.

The brain only acts via `agent.act()` as `brain:npc` at `PRIORITY.npc`, so the action lock
stays in charge. A player's `!stop` aborts the NPC's action and also makes it back off.

```mermaid
flowchart TB
  TICK(["tick every 1.5 s"]) --> BB["refresh blackboard<br/>needs + facts"]
  BB --> HK["run hooks<br/>(greetings ...)"]
  HK --> HELD{"body held by<br/>player / LLM / reflex?"}
  HELD -- yes --> BACK["back off<br/>3–20 s"] --> TICK
  HELD -- no --> SC["score every behaviour 0–100"]
  SC --> PICK{"best beats current<br/>by 10 (or ≥ 80)?"}
  PICK -- no --> KEEP["keep running current"] --> TICK
  PICK -- yes --> SW["abort current,<br/>start best"] --> RUN["behaviour runs:<br/>agent.act at npc (20)"]
  RUN -- done --> CD["cooldown"] --> TICK
  RUN -- failed --> FB["failure backoff<br/>5 s doubling to 2 min"] --> TICK
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class TICK,BB,HK,SC a
  class HELD,PICK d
  class SW,RUN,KEEP,CD g
  class BACK,FB r
```

## Blackboard

`ctx.bb` in every score and run:

| | |
|---|---|
| `needs.hunger` | 0 full .. 1 starving |
| `needs.health` | 0 .. 1 |
| `needs.danger` | 0 safe .. 1 hostile touching us (within `dangerRadius`, default 12) |
| `needs.inventoryFull` | share of slots used |
| `needs.tiredness` | ramps up at dusk, 1 at night |
| `facts.isNight` | the bed window (12542..23459) or a thunderstorm |
| `facts.sleeping`, `facts.timeOfDay` | |
| `facts.home`, `facts.homeDistance` | from the navigation skill's stored home |
| `facts.nearestHostile` | `{ id, name, distance }`, neutral mobs (`ignoreMobs`) excluded |
| `facts.nearestPlayer` | `{ name, distance }` within `playerRadius` (16) |

Custom needs: `bb.setNeed('boredom', 0.4)` in a hook, `bb.need('boredom')` in a score.
`bb.memory` is per-session scratch; `bb.recall(key, fallback)` / `bb.persist(key, value)`
store under `npc.<key>` in `agent.storage`.

## Writing a behaviour

```ts
import type { Behavior } from '../src/brains/npc/index.ts'

const fishAtDawn: Behavior = {
  name: 'fish',
  requires: ['fish'],                  // scores 0 if the bot has no "fish" action
  cooldownMs: 10 * 60_000,             // after a success
  failureCooldownMs: 30_000,           // doubles per consecutive failure, capped at 2 min
  score: ({ bb }) => bb.facts.timeOfDay > 23000 || bb.facts.timeOfDay < 1500 ? 35 : 0,
  async run (ctx) {
    await ctx.act('goto_place', { name: 'pond' })
    return ctx.act('fish', { minutes: 2 })   // ok/fail result decides cooldown vs back-off
  }
}
```

- `score(ctx)` should be cheap; return 0 when not applicable. Rough bands: idle 5-15,
  social 15-25, chores 25-45, routine 40-70, needs 50-90, danger 70-100.
  `ctx.current` names the running behaviour, so a score can commit to finishing
  (see `goHome`).
- `run(ctx)` gets `ctx.act(name, params)` (npc caller and priority filled in), `ctx.wait(ms)`
  and `ctx.signal`. When another caller takes the body, `ctx.act` throws and the brain backs
  off; you don't need to handle it. Return an action result, a string, nothing (success) or
  `false` (failure).
- Prefer bounded actions over long-running ones (`goto_player` in a loop rather than
  `follow`), so the brain gets the slot back.

### Any action as a behaviour

```ts
actionBehavior('harvest', {}, ({ bb }) => bb.facts.isNight ? 0 : 30, { cooldownMs: 300_000 })
actionBehavior('deposit', { chest: 'home' }, ({ bb }) => bb.needs.inventoryFull > 0.8 ? 45 : 0)
```

It requires the action, so listing chores whose skills the bot doesn't have is harmless.

## Built-in behaviours

| factory | score | needs actions |
|---|---|---|
| `fleeOrFight()` | 70-100 with a hostile near; fights within 5 blocks when healthy, flees from creepers or at low health | `attack` / `flee` |
| `eatWhenHungry()` | 50-90 below food 12 ([reflexes](/concepts/world#reflexes) eat at 15 first) | `eat` |
| `sleepAtNight()` | 70 at night: go home, sleep, stay in bed until morning | `sleep` (+`go_home`) |
| `goHome()` | 35+ when over 32 blocks away, 50 at night beyond 6 | `go_home` |
| `followNearbyPlayer()` | 18 when a player is within 10: walk over, look at them for 20 s, 90 s cooldown | `goto_player` |
| `wander()` | 10: short walk near home (radius 4 at night), then a pause | `wander` |
| `greetPlayers()` (hook) | says hi to players within 8, at most once per player per 30 min and once per 5 min overall, 50% roll | - |

## Navigation skill

`navigation()` adds `wander`, `set_home`, `go_home`, `remember_place`, `forget_place`,
`places`, `goto_place` and `flee`. Home and places are stored in `agent.storage` (`home`,
`places`). The NPC brain sets home to the spawn point when none is stored (`autoHome`).

## Debugging

- `!npc_status`: current behaviour, top scores, needs, back-off. Its `data` has the full
  JSON (cooldowns, last outcome per behaviour).
- `MC_LOG_LEVEL=debug` logs every start, switch, stop, back-off and failure cooldown under
  `<bot>/npc`.
