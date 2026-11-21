# Movement, protection and combat

How bots get around, what they learn about the world, and how they fight. These live in core
and the standard skills, so every [variant](/concepts/variants-profiles) gets them.

## Long-distance travel

Mineflayer's pathfinder can only plan through chunks the bot has loaded, so a target thousands
of blocks away used to "arrive" without moving. `travel()` (core helper, used by `goto`) walks
in legs:

```mermaid
flowchart LR
  S(["goto 3000 blocks away"]) --> D{"remaining<br/>≤ 64 blocks?"}
  D -- no --> L["leg: aim 64 blocks<br/>towards the target"]
  L --> P{"progress<br/>≥ 8 blocks?"}
  P -- yes --> D
  P -- no --> A["detour: try ±30°, ±60°, ±90°"]
  A --> P2{"progress?"}
  P2 -- yes --> D
  P2 -- "no, 3 times" --> F(["fail: stuck at x y z,<br/>N blocks left"])
  D -- yes --> FIN["final approach<br/>GoalNear / GoalNearXZ"]
  FIN --> V{"really there?<br/>(≤ range+1, |dy| ≤ 3)"}
  V -- yes --> OK(["ok: arrived at x y z"])
  V -- no --> F
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class S,L,A,FIN a
  class D,P,P2,V d
  class OK g
  class F r
```

- `goto` is **long-running**: LLM brains start it in the background and get an `actionDone`
  follow-up with the real outcome; `!goto` in chat replies when it ends.
- It only reports arrival when the bot actually stands at the target.
- [Retries](/guide/profiles#retries) (`retry.actions.goto`) re-run it after "stuck" failures.

```ts
await travel(bot, { x: 640, z: 60 }, signal, { stepBlocks: 64, onProgress: p => log.debug('travel', p) })
```

## Protected areas

Servers refuse block breaking in some places (spawn protection, claims). A refused break looks
like success to mineflayer: it marks the block as air, then the server restores it. Bots learn
these areas instead of looping:

```mermaid
sequenceDiagram
  autonumber
  participant B as Bot
  participant S as Server
  participant P as protectedAreas
  participant PF as Pathfinder
  B->>S: dig dirt at 545 70 45
  S-->>B: block_change: dirt is back
  B->>P: markProtected(545 70 45)
  P->>P: new zone (radius 20), save data/protected-host-port.json
  P->>PF: digging inside zones costs ∞, re-plan now
  Note over B: collect / chop_tree skip blocks in zones,<br/>walk out once if everything nearby is protected
```

- Zones are saved per server and loaded on every start, for every bot on that server.
- `agent.protectedAreas.isProtected(pos)`, `agent.markProtected(pos)` from code.
- `digBlock()` (skills/world.ts) throws `DigRefusedError` on a refusal; skills that dig use it.
- Delete `data/protected-*.json` if a server's protection changes.

## Hostile mobs

`isHostile()` decides what bots fight. minecraft-data marks some aggressive mobs as plain
"mob", so they're added explicitly; neutral mobs are never targeted proactively.

| | mobs |
|---|---|
| hostile (data says so) | zombie, skeleton, creeper, spider, drowned, witch, ... |
| also hostile | phantom, ghast, slime, magma_cube, shulker, hoglin, ender_dragon |
| never targeted | enderman, piglin, zombified_piglin (neutral), evoker_fangs, skeleton/zombie horses |
| modded | from the [registry sync](/concepts/neoforge#_4-modded-item-and-entity-names); `ars_nouveau:wilden_*` built in, more via `settings.moddedHostile` / `MC_MODDED_HOSTILE` |

**Flying mobs** (phantom, ghast, vex, blaze, breeze, ...) aren't chased on foot: the bot holds
position, tracks them and swings when they dive into reach. Reflexes look up to 20 blocks for
flyers that hit and climbed away, and never try to outrun them.

## Reflexes

The `reflexes()` brain reacts at the highest brain priority (60), preempting everything and
letting long-running actions resume afterwards.

```mermaid
flowchart TB
  H(["bot got hurt"]) --> M{"hostile within 8<br/>(flyers: 20)?"}
  M -- no --> X(["ignore"])
  M -- yes --> R{"retreat?<br/>health ≤ retreatBelow, or<br/>mob in water and health &lt; waterFightAbove<br/>(never for flyers)"}
  R -- yes --> RT["retreat: back off 18 blocks"]
  R -- no --> DF["defend: fight it"]
  T(["every 2 s"]) --> E{"food &lt; eatBelow<br/>or hurt and safe?"}
  E -- yes --> EAT["eat best food"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class H,T a
  class M,R,E d
  class DF,EAT g
  class RT r
  class X a
```

Tune per variant (`reflexes({ ... })`) or per profile:

```yaml
reflexes:
  selfDefense: true
  autoEat: true
  eatBelow: 15          # eat when food drops below this
  retreatBelow: 8       # back off at or below this health; 0 = stand your ground
  waterFightAbove: 14   # don't fight mobs in water below this health; 0 = always fight
```

Pax uses `retreatBelow: 0` and `waterFightAbove: 0`: it always fights back.

## Where this shows up elsewhere

- Deaths, damage and protected areas are recorded in the [journal](../guide/journal).
- [Humanize](../guide/profiles#humanize-player-like-timing) adds reaction and typing delays on
  top of all of this for immersive bots.
- Modded item and mob names come from the [NeoForge registry sync](./neoforge).
