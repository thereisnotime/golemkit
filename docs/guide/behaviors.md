# Behaviours

Armed behaviours are things a bot keeps doing on its own until told otherwise: stay fed,
stay safe, follow its owner, guard a farm, keep wood in stock. You switch them on and tune
them per [profile](/guide/profiles), from chat, from an LLM tool call, from `hooks.yaml` or from a
[self-improver](/guide/self-improver) program. Once armed, a behaviour runs without any more LLM turns or commands.

The motivating case: an LLM bot sat at 6/20 health with no food and died twice, because
nothing made it go and get food, and nothing ran between its turns. With `keep_fed` armed
it hunts, cooks and eats by itself, scouts further out when there is nothing near, and with
`farm_setup` it grows its own food ([details](#food-keep-fed-scouting-and-farm-setup)).

## Actions, brains and behaviours

| | what it is | who starts it | how long it runs |
|---|---|---|---|
| **action** | one thing the body does (`hunt`, `goto`, `eat`) | anyone, via `agent.act()` | until done, stopped or preempted |
| **brain** | a decision loop (commands, [reflexes](/concepts/world#reflexes), LLM, NPC) | the [variant](/concepts/variants-profiles) | the whole session |
| **behaviour** | a scored, option-validated routine run by the behaviours brain | armed from config, chat, LLM, hooks, programs | until disarmed, across restarts |

A behaviour is an [NPC-brain](npc-brain.md) behaviour (score + run) with a name, a zod
options schema, a description written for LLMs and some metadata. The behaviours brain
holds the **armed** set and runs it through the same `NpcController`, so the scoring,
hysteresis, failure back-off and back-off from other callers are exactly the [NPC brain](/guide/npc-brain)'s.

```ts
import { behaviorsBrain } from '../src/brains/index.ts'

brains: [
  commandBrain(),
  reflexes(),
  hooksBrain(),
  behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } }),
  llmBrain({ ... })
]
```

## How it fits together

```mermaid
flowchart LR
  subgraph src["Arming sources"]
    direction TB
    VAR["variant defaults<br/>behaviorsBrain({ defaults })"]
    PROF["profile<br/>behaviors: block"]
    CHAT["owner chat<br/>!behavior_arm"]
    LLM["LLM tool call<br/>behavior_arm (brain:llm)"]
    HOOK["hooks.yaml<br/>act: behavior_arm"]
    SELF["self-improver<br/>act step"]
  end
  subgraph rt["Behaviours brain"]
    direction TB
    CFG["config<br/>(validated at load)"]
    ST[("agent.storage<br/>behaviors: runtime changes")]
    ARM["armed set<br/>name + options"]
    CTL["NpcController<br/>score · decide · back off"]
  end
  subgraph body["Body"]
    direction TB
    LOCK{{"Action lock"}}
    ACT["actions<br/>hunt · smelt · eat · follow · retreat"]
  end
  VAR & PROF --> CFG --> ARM
  CHAT & LLM & HOOK & SELF -->|"behavior_* actions"| ST --> ARM
  ARM -->|"keep_fed 35 · stay_safe 35<br/>follow_owner 20 · wander 10"| CTL
  CTL -->|"agent.act(caller brain:behaviors)"| LOCK --> ACT
  REF["reflexes 60 · players 50<br/>hooks 40 · LLM 30"] -->|"outrank"| LOCK

  classDef src fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef brain fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  classDef store fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef lock fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef skill fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef ext fill:#fef3c7,stroke:#d97706,color:#78350f
  class VAR,PROF,CHAT,LLM,HOOK,SELF src
  class CFG,ARM,CTL brain
  class ST store
  class LOCK lock
  class ACT skill
  class REF ext
```

Config is the base. Runtime changes (arm, disarm, configure from any action caller) are
stored in `agent.storage` under `behaviors` and win over the config, so they survive
restarts. `behavior_reset` drops them again.

## Arming

### From a profile

```yaml
# profiles/pax.yaml
behaviors:
  keep_fed: { below: 14 }         # options map: armed with these options
  stay_safe: true                 # armed with defaults
  wander: { enabled: false }      # explicitly off (e.g. to override a variant default)
```

Names and options are checked against the registry when the profile is run: an unknown
name (`keep_food`, with a "did you mean keep_fed") or a bad option (`below: 40`, out of
range; `bellow: 10`, unknown key) stops the bot before it connects, with every problem
listed. Variants set defaults with `behaviorsBrain({ defaults })`; the profile merges over
them per behaviour (options merge, `enabled` is replaced).

### From chat (owners only)

```
!behavior_list                         names by category, * = armed
!behavior_list keep_fed                description, options and defaults
!behavior_arm keep_fed below=10 hunt=false
!behavior_arm keep_fed {"animals": ["cow", "pig"]}
!behavior_arm collect_drops items=oak_log,stick
!behavior_configure guard_area radius=20
!behavior_disarm follow_owner
!behavior_status                       armed set, what runs, last outcomes, cooldowns
!behavior_reset                        back to the profile's set
```

Options are `key=value` words (lists comma-separated) or a JSON object. Only owners
(`owners:` in the profile) get past the command brain at all, and the actions refuse
non-owners again: a player caller who is not an owner, or an LLM or hook acting for a
non-owner player, gets `only my owners can change my behaviours`.

### From an LLM

Every behaviour action is a tool. The descriptions say *when* to arm what ("arm keep_fed so
you look after your own food without being asked"), and the LLM arms as `brain:llm` (shown
in `behavior_status`). Pax's [context pack](/guide/context-pack) has one rule for it:

> For ongoing needs (staying fed, following or guarding robin, guarding a place, farming,
> keeping wood stocked) arm a behaviour with behavior_arm instead of doing it turn by turn.

`observe()` includes `behaviors: { armed, running }`, so the model sees what is already on.

### From hooks and programs

```yaml
# profiles/pax/hooks.yaml
hooks:
  - id: guard-at-night
    on: timer
    every: 5m
    when: { isDay: false }
    do:
      - act: behavior_arm
        params: { name: guard_owner }
```

Self-improver programs can call the behaviour actions too (they are not on its deny list),
so a taught rule like "guard the farm at night" can arm `guard_area` instead of
re-implementing it.

## Priorities and back-off

Each behaviour runs at a level: `idle` (10), `npc` (20) or `behavior` (35). The default
comes from the definition and every behaviour takes a `priority` option to override it.

`PRIORITY.behavior` (35) is the one core addition: above the LLM (30), below hooks (40),
players (50) and reflexes (60). Survival behaviours (`keep_fed`, `stay_safe`, `avoid_mobs`)
use it, so a bot whose LLM is busy following someone still gets fed: the LLM's long-running
action is suspended and resumes when the behaviour is done.

```mermaid
flowchart TB
  T(["tick (1 s)"]) --> H{"who holds the body?"}
  H -- "player / reflex / hooks (≥ 40)" --> P["every behaviour backs off<br/>player 20 s · reflex 3 s"]
  H -- "LLM (30)" --> L["npc / idle levels back off 20 s<br/>behavior level (35) keeps going"]
  H -- "nobody, or lower" --> S["score the armed set"]
  L --> S
  S --> D{"decide()<br/>margin 10 · urgent ≥ 80"}
  D --> R["run winner via agent.act<br/>at its own priority"]
  R -- "outranked mid-action" --> P
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class T,S a
  class H,D d
  class R g
  class P,L r
```

- The back-off is per level: while an LLM holds the body, `npc` and `idle` behaviours are
  paused, `behavior`-level ones are not. A player, hook or reflex pauses everything.
- Disarming or reconfiguring a running behaviour stops it at once.
- `follow_owner` and `guard_owner` run the long-running `follow` / `guard` actions. That is
  fine here: the controller still re-scores every tick and interrupts them when something
  scores higher, and a preempted action of ours is dropped rather than resumed behind the
  brain's back.

### Reflexes and stay_safe

`reflexes()` reacts to being hit: fight back, retreat at 8 health or less, eat when food is
carried. `stay_safe` acts earlier and on what reflexes don't cover: backing off at 10 health
before the next hit, pillaring up when surrounded (only if it can place blocks and carries
dirt/cobblestone/planks), leaving water when mobs are near, going home at night. Both use
the same `retreat`/`flee` actions and the reflex always outranks the behaviour, so they
never pull the body two ways. `keep_fed` likewise leaves "eat what you carry" to the reflex
(food < 15) and steps in below 14, or when health is low and food is under 18 (no regen).

## Bodyguard

`bodyguard` protects a player (default: the first owner online) without any LLM turns. Pax has
it in its profile switched off; an owner turns it on with `!behavior_arm bodyguard` (or "guard
me"), off with `!behavior_disarm bodyguard`, and tunes it with `!behavior_configure bodyguard
range=20 warn=false`.

```mermaid
flowchart TB
  T(["tick"]) --> ON{"player online?"}
  ON -- no --> G["wait where they were last seen<br/>or go home (whenGone)"]
  ON -- "yes, out of sight" --> C["walk to where they<br/>were last seen"]
  ON -- "yes, in sight" --> W["warn in chat<br/>(rate limited)"]
  W --> R{"threats to the player?<br/>ranked from the player"}
  R -- "creeper within 6" --> F["fight it first"]
  R -- "archer with a shot" --> A{"can reach it?"}
  A -- yes --> F
  A -- no --> B["stand in its line of fire<br/>behind a shield"]
  R -- "diving phantom,<br/>mob coming for them,<br/>hurt them" --> F
  R -- none --> Q{"player hurt,<br/>bot has spare food?"}
  Q -- yes --> FD["toss food"]
  Q -- no --> P["stand between the player<br/>and the nearest mob, or follow"]
  F -- "outnumbered or about to die" --> E["reflexes / stay_safe:<br/>retreat, eat, pillar"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef v fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  class T,G,C a
  class ON,R,A,Q d
  class W,P,FD g
  class F,B v
  class E r
```

- **Threats** are judged from the player: anything that hurt them (damage events name the source,
  arrows the shooter), a creeper within 6 of them (always first), an archer with a clear line to
  them inside `range`, a phantom diving at them, a mob inside `range` walking towards them or
  looking at them, anything within 5 of them, and whatever attacks the bot. Neutral mobs
  (endermen, piglins, wolves) only when they attack; players, pets, villagers, golems and named
  mobs never. A melee mob hitting the player from within 3 blocks goes before archers (a creeper
  by them still goes first). The fight itself is the [fight loop](/concepts/world#fighting) with
  `maxChase` set to `range`, stopped early when a creeper comes up to the player, the target leads
  the bot away, or a re-rank (every 0.6 s) finds a threat that scores clearly higher, such as a
  zombie reaching the player while the bot chases an archer. With a bow (skeletons drop them)
  it never shoots while the player is near the line of fire, up to 4 blocks past the target; it
  closes in instead.
- **Position**: with a mob around but nothing to fight, the bot stands on the line between the
  player and the mob at the follow distance (at most halfway). Flyers are fought from next to
  the player.
- **Archers** it can't get to (on a ridge, across water) are blocked instead for 20 s: it stands
  where it covers the arrow's line to the player and raises a shield (archers high up shoot
  steeply, so the spot moves right next to the player; when no spot covers the line it closes in).
- **Warnings** (`warn`): "creeper behind you", "2 zombies to your left", "skeleton on the ridge
  east", "phantoms incoming". Melee mobs and creepers are relative to where the player looks,
  archers by compass. At most one every 5 s, the same one (kind and direction) every 30 s. Public
  chat, or whispers with `whisper: true`.
- **Feeding** (`feed`): the server sends other players' health in entity metadata but never their
  hunger, so it feeds by health only: at 10 or less, within 5 blocks, nothing close, at most
  every 30 s, 1-2 of its best food, never below `keepFood` items for itself. It whispers what it
  tossed. Where the server hides player health it doesn't feed at all.
- **Night**: while it is armed and the player is online, `stay_safe` doesn't go home or dig in;
  the reflexes don't [bunker](/concepts/world#phantoms-bunker) away from phantoms unless health is 6 or less. Low health
  (retreat) and the back-off to eat at 4 health still apply; surrounded (pillar, or back off)
  only at 12 health or less, because every wave that reaches the player surrounds the bot too.
- **Reflexes**: while `protect` holds the body the reflexes don't start `defend` over it (it fights
  what attacks the bot too, ranked after threats to the player); when it isn't running they defend
  the bot as usual. Priority level `behavior` (35) beats `follow_owner`/`guard_owner` and the LLM's
  actions, so an armed bodyguard keeps the body while the player is in sight; arm it with
  `priority: npc` to let the LLM work in between.
- **Gone**: player out of sight but online: walk to where they were last seen (up to `catchUp`).
  Offline: wait there (`whenGone: stay`) or go home (`whenGone: home`).

The actions behind it are usable on their own: `protect` (the loop) and `feed_player`.
`scripts/guard-test.ts` is the older smoke test (natural night spawns, too few mobs to mean much).

### Benchmark: `just guard-bench`

`scripts/guard-bench.ts` is the controlled version. ClaudeTest (an op) directs; GuardTest is
the bot and GuardTester the owner, who stands still (no self-defence, eats bread). Before every
phase the director sets the time to morning, kills leftover tagged mobs, fills creeper holes in
the arena floor, resets both players to full health and hunger, gives the same gear (bot: iron
sword, shield, 16 bread, iron armour with `--armour`; tester: 8 bread) and teleports both to the
spot, the bot 3 blocks east. Then it summons a seeded wave schedule 8 to 14 blocks around the
tester every 30 s while fewer than 8 are alive: 2 zombies and a skeleton (leather helmets so
they don't burn, the skeleton with a bow), a spider, and a creeper every other wave. Phases:
`guard` (bodyguard armed for the tester), `follow` (`follow_owner` only), `none` (bot offline).
The order flips on every repeat. A tester death is counted, the mobs alive are killed and the
tester is reset on the spot.

```sh
just guard-bench --scout                      # check the spot (flat, dry) and robin's distance
just guard-bench                              # 1250 445, 2 repeats x 3 phases x 4 min
just guard-bench 1250 445 --minutes 4 --repeats 3 --armour --tag mytest
just guard-bench --cleanup                    # kill tagged mobs, clear both players
```

Results append to `data/guard-bench/results.jsonl` and a table prints at the end. Daytime keeps
natural spawns out, but spiders don't pick targets in daylight, so in practice the waves are
zombies, skeletons and creepers.

**Results** (mc02, 22 Nov 2026, spot 1250 70 445, seed 1, iron sword and shield, no armour,
4 minutes per phase, 2 repeats, order flipped). "Before" is the bodyguard as first shipped,
"after" is with the three fixes described under Threats and Night above. Each phase summons
36 mobs (8 waves) unless the cap held waves back.

| set | phase | tester hits (each run) | mean hits | mean damage | tester deaths | bot deaths | bot kills (mean) | creeper blasts within 6 | warnings (mean) |
|---|---|---|---|---|---|---|---|---|---|
| before | guard | 55, 60 | 57.5 | 189 | 5, 6 | 2, 3 | 12.5 | 0, 2 | 22 |
| before | follow | 67, 54 | 60.5 | 200 | 5, 5 | 2, 2 | 11 | 1, 2 | 0 |
| before | none | 69, 58 | 63.5 | 202 | 6, 6 | - | - | 1, 2 | 0 |
| after | guard | 43, 34 | 38.5 | 138 | 4, 3 | 4, 2 | 16 | 2, 2 | 22 |
| after | follow | 67, 53 | 60 | 181 | 6, 4 | 2, 1 | 10 | 2, 1 | 0 |
| after | none | 60, 61 | 60.5 | 213 | 6, 6 | - | - | 3, 1 | 0 |

The median time from a wave's spawn to its first hit on the tester was 4 to 5 s in every phase:
the bot doesn't stop the first hit, it shortens the fight after it. Feeding happened 3 times in
all (the tester ate its own bread too).

How to read it:

- Before the fixes the bodyguard was no better than `follow_owner`, and neither was much better
  than no bot (57 / 60 / 63 hits). The logs showed why: it chased skeletons while a zombie hit
  the player, stay_safe pulled it out every time three mobs reached the player, and once it shot
  the player with a bow it had picked up (2 hits). After the fixes the guard phases took about a
  third fewer hits and deaths than follow or none in the same session, with no friendly fire.
- Two runs per cell is little. An earlier session with the "before" code (4 phases before it
  was stopped) had guard 36, follow 40 and none 77 and 81 hits, so whole sessions shift by 15 to
  20 hits; compare phases within a set, not across sets.
- The bot dies more after the fixes (6 deaths in 8 minutes against 5), because it no longer runs
  from crowds. Most bot deaths are creepers it fights point blank without armour: a creeper by
  the player still goes first, and a sword at melee range lets it go off. `--armour` would
  change that picture; it hasn't been measured yet.
- Fairness: in the first "after" follow phase the 8-alive cap held back 2 waves (27 mobs instead
  of 36), so that phase is if anything easier than the others. Spiders don't attack in daylight,
  so the waves are effectively zombies, skeletons and creepers. Zombies did 75-90% of all hits.

## Food: keep_fed, scouting and farm_setup

`keep_fed` used to look only within its `radius`; near a busy spawn there is often nothing,
so it backed off and the bot starved. It now goes further, step by step, and as a last
resort grows its own food. The choice is the pure `nextFoodStep(world, options, tried)`;
a step that fails is added to `tried` and the next one is picked.

```mermaid
flowchart TB
  H(["hungry: food below `below`,<br/>or hurt and food below 18"]) --> E{"ready food<br/>in the bag?"}
  E -- yes --> EAT["1 · eat"]
  E -- no --> C{"raw meat/potato,<br/>furnace + fuel?"}
  C -- yes --> COOK["2 · cook (smelt)"]
  C -- no --> B{"3+ wheat?"}
  B -- yes --> BREAD["3 · bake bread"]
  B -- no --> CH{"food in a<br/>known chest?"}
  CH -- yes --> WD["withdraw"]
  CH -- no --> F{"own farm ripe<br/>(or due a visit)?<br/>village crops in range?"}
  F -- yes --> FARM["4 · harvest farm:n<br/>(replants)"]
  F -- no --> SP{"remembered spot<br/>food:animals ·<br/>food:village_farm?"}
  SP -- "yes (in range, or nothing<br/>to hunt here)" --> SPOT["5 · go there, look"]
  SP -- no --> HU{"animals above<br/>keepAtLeast?<br/>(any, if starving)"}
  HU -- yes --> HUNT["6 · hunt (safety filter)"]
  HU -- no --> N{"day, or<br/>scoutAtNight?"}
  N -- no --> BACK(["fail truthfully, back off<br/>stay_safe takes it home"])
  N -- yes --> SC["7 · scout: find_food<br/>spiral out to scoutRadius"]
  SC -- "found animals / crops" --> HU
  SC -- "nothing" --> SF{"no farm yet,<br/>seeds or grass?"}
  SF -- yes --> START["8 · start_farm by water<br/>(food in a few days)"]
  SF -- no --> BACK
  START --> BACK
  EAT & COOK & BREAD & WD & FARM & SPOT & HUNT -->|"re-sense, loop"| E

  classDef trig fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef ask fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef near fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef far fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef grow fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class H trig
  class E,C,B,CH,F,SP,HU,N,SF ask
  class EAT,COOK,BREAD,WD,HUNT near
  class FARM,SPOT,SC far
  class START grow
  class BACK stop
```

- **Order:** eat, cook, bake, (eat safe raw meat), chest, crops in range, own farm, known
  food spot, hunt, scout, start a farm. A known spot further than `radius` only wins over
  hunting when there is nothing to hunt where the bot stands.
- **Scouting** (`find_food`): known spots first, then an expanding spiral around home (rings
  every 64 blocks, waypoints every ~96, starting on the side away from the world spawn) out to
  `scoutRadius`. It skips waypoints over open water or lava and in protected areas, gives up on
  a direction once a leg gets stuck there, and stops at night, at health 6 or less, with three
  mobs around, after 4 stuck legs in a row, or after `maxMinutes`. It stops walking as soon as
  animals or a village farm come into view.
- **Memory:** sightings are stored with a timestamp (`agent.storage` key `foodSpots`) and as
  places `food:animals`, `food:village_farm` and `food:water`, plus a `food_spot` [journal](/guide/journal)
  event. Animal spots go stale after 6 hours, an empty visit pauses a spot for 30 minutes, and
  two empty visits in a row forget it.
- **Never from other players:** crops count only on the bot's own farms (`farm:<n>`) or on a
  village farm (villagers within 24 blocks); `anyCrops: true` lifts that (e.g. for its owner's
  field). Animals go through the hunt filter (no pets, named, tamed, leashed or baby animals,
  never villagers, never in protected areas, nothing inside fences except on its own farm).
- **Herd:** `keepAtLeast` (default 2) adults of each kind are spared; they are only hunted
  when starving (health or food 6 or less).
- **Night and reflexes:** far trips (scouting, known spots, its farm out of range, building a
  farm) only happen by day unless `scoutAtNight`; at night keep_fed fails and backs off, and
  `stay_safe` (night score 48, below keep_fed's 55+) takes the bot home. Eating what it carries
  stays with the reflexes, which always outrank behaviours.
- **Reports** say what happened: `still hungry (food 6/20): scouted 192 blocks east and
  north-east of home, no animals or village crops; stopped: walked 24 legs; started a 9x9 wheat
  farm at 812 63 -40 (farm:1): tilled 64, planted 9`.

```
!behavior_configure keep_fed scout=true scoutRadius=200
!behavior_configure keep_fed scoutAtNight=false keepAtLeast=3 startFarm=false
```

### farm_setup

`farm_setup` keeps the bot fed long term. With no farm it runs `start_farm`:

1. a site near home (or `place`), checked first so it doesn't collect seeds for nothing: shore
   water (a source with land next to it) within `radius`, then out to 96 blocks, each scored on
   a 9x9 square at the water's height. Protected areas, the world spawn (`spawnClearance`),
   placed blocks (planks, cobblestone, glass, fences, torches, beds, chests...) and existing
   farmland within 3 blocks rule a site out. At least 8 cells must be grass/dirt with air or a
   plant on top, or a one-block grass bank it can dig off (farmland only stays wet with water
   at its own height or one above); more such cells, closer and fewer extra water holes is
   better. Without natural water it tries a water spot it saw while scouting, then a water
   bucket (filling an empty bucket first);
2. seeds: breaks grass until it has `seeds` (wheat seeds drop 1 in 8), or uses carrots,
   potatoes or beetroot seeds it carries;
3. a hoe: from the inventory, crafted, or crafted after chopping a few logs;
4. till every usable cell around the water (one source hydrates 4 blocks out, so 9x9 is
   the most), plant, fence the ring outside with a gap on the south side and torch the corners
   when it has (or can craft) the fences and torches;
5. save it as `farm:<n>` (place and `farms` storage), journal `farm_started`.

After that it tends the farm when `minRipe` crops are ripe (or every `tendMinutes` when it is
out of sight and within `tendRange`), bakes bread keeping `keepWheat` for breeding, and breeds
animals it has food for (`breed`: cows/sheep wheat, pigs carrots/potatoes/beetroot, chickens
seeds, leading them to the farm first, never past `maxHerd`). It works by day, never while
hungry (keep_fed's job), and only in survival. `farm_loop` can tend the same field with
`place: farm:1`.

## Capabilities

A behaviour lists the actions it `requires`; if the bot lacks one it is skipped with a
warning (and `behavior_arm` reports "armed, but it can't run: ..."). `needs: { dig }` checks
`canDig`, `needs: { place }` checks `settings.canPlace` (default true; set it to false in a
profile's `settings` to keep a bot from placing blocks). Chores never act in [protected areas](/concepts/world#protected-areas)
(spawn): `chop_tree` skips them, `chop_wood_loop` keeps `spawnClearance` from the world
spawn, `hunt` skips animals inside protected areas and, by default, animals inside fences.

## Library

The table below is generated from the registry (`node scripts/gen-docs.ts`). Every
behaviour also accepts `priority: idle | npc | behavior`.

<!-- behaviors:start -->
<!-- generated by scripts/gen-docs.ts from the behaviour registry, do not edit by hand -->

### `stay_safe`

*safety · priority behavior (35) · uses `retreat`, `flee`, `pillar`, `goto`, `go_home`, `bunker` when present*

Keeps the bot alive: backs away from mobs at low health, pillars up when surrounded (if it can place blocks), gets out of water when mobs are around, heads home at night if a home is set (sooner when it has no armour, weapon or food), and without a home digs in for the night when it is unprepared. Arm it on any bot that roams.

| option | type | default | description |
|---|---|---|---|
| `retreatBelow` | number (0..20) | `10` | back off from nearby mobs at or below this health; 0 = never (reflexes retreat at 8 when hit) |
| `mobRadius` | number (4..24) | `10` | mobs this close count as a threat |
| `surroundedBy` | integer (2..10) | `3` | this many hostiles within 6 blocks means surrounded |
| `pillar` | boolean | `true` | when surrounded, pillar up out of reach (needs blocks and block placing) |
| `avoidWater` | boolean | `true` | get out of water when hostiles are near and health is below 16 |
| `homeAtNight` | boolean | `true` | go home at night if a home is set |
| `homeRange` | number (2..64) | `8` | how close to home counts as home at night |
| `shelterUnprepared` | boolean | `true` | at night without armour, a weapon or food and no home: dig in (bunker) until morning |

### `avoid_mobs`

*safety · priority behavior (35) · needs `flee`*

Keeps its distance from dangerous mobs (creepers, wardens by default) instead of fighting them. Arm it on bots that work outdoors.

| option | type | default | description |
|---|---|---|---|
| `mobs` | list | `["creeper","warden"]` | mob names to keep away from |
| `distance` | number (3..16) | `7` | start moving away when one is this close |

### `keep_fed`

*survival · priority behavior (35) · needs `eat` · uses `withdraw`, `harvest`, `hunt`, `smelt`, `craft`, `goto`, `goto_place`, `list_container`, `find_food`, `start_farm` when present*

Looks after food on its own: when hungry (or hurt and too hungry to heal) it eats, and when it has nothing to eat it cooks or bakes, takes food from known chests, harvests its own or a village farm, goes back to remembered food spots, hunts passive animals (sparing a small herd), scouts further out when nothing is near, and as a last resort starts a farm. Arm it so you never starve between turns.

| option | type | default | description |
|---|---|---|---|
| `below` | number (1..20) | `14` | look for food when the food bar is below this (reflexes eat at 15 when food is carried) |
| `healBelow` | number (0..20) | `14` | also look for food when health is below this and food is too low to heal (<18) |
| `until` | number (1..20) | `18` | keep eating until the food bar reaches this |
| `chests` | boolean | `true` | withdraw food from chests the bot has looked into |
| `chestPlace` | string |  | a remembered place with a food chest to check first |
| `harvest` | boolean | `true` | harvest ripe crops on its own farms and village farms |
| `anyCrops` | boolean | `false` | also harvest crops that are not its own or a village's (e.g. its owner's field); off = never touch other players' farms |
| `hunt` | boolean | `true` | hunt passive animals (never pets, named, tamed or leashed animals) |
| `keepAtLeast` | integer (0..32) | `2` | leave at least this many adults of each kind (only hunted when starving: health or food 6 or less) |
| `animals` | list of cow, pig, sheep, chicken, rabbit, mooshroom | `["cow","pig","sheep","chicken","rabbit","mooshroom"]` | animals it may hunt |
| `cook` | boolean | `true` | cook raw meat/potatoes when a furnace and fuel are available or craftable |
| `eatRaw` | boolean | `true` | eat raw meat when cooking is not possible (never raw chicken) |
| `radius` | number (4..64) | `32` | how far to look for crops and animals |
| `places` | boolean | `true` | go back to remembered food spots (food:animals, food:village_farm) |
| `scout` | boolean | `true` | when nothing is in range, scout further out (find_food) for animals and village farms |
| `scoutRadius` | number (32..512) | `200` | how far from home to scout |
| `scoutAtNight` | boolean | `false` | also make far trips (scouting, known spots, its farm) at night |
| `startFarm` | boolean | `true` | as a last resort, start a farm (start_farm) when it has none and has or can get seeds |

### `bodyguard`

*combat · priority behavior (35) · needs `protect` · uses `goto`, `go_home` when present*

A real bodyguard for its owner (or a given player), no LLM needed: stays close and between them and danger, kills mobs that threaten them (creepers near them first, archers with a shot at them, diving phantoms, mobs coming for them or that hurt them), blocks arrows with a shield, warns them in chat, tosses them food when they look hurt, and stays with them at night instead of going home. Never attacks players, pets, villagers, golems or named mobs. Arm it when your owner says "guard me".

| option | type | default | description |
|---|---|---|---|
| `player` | string |  | who to protect; default the first owner online |
| `distance` | number (1..8) | `3` | follow distance, blocks |
| `range` | number (6..32) | `16` | protect radius around the player, blocks |
| `feed` | boolean | `true` | toss food to the player when their health is low (only if the server sends player health) |
| `keepFood` | integer (0..64) | `4` | food items to keep for itself when feeding |
| `warn` | boolean | `true` | warn the player in chat: "creeper behind you", "skeleton on the ridge east", "phantoms incoming" |
| `chat` | boolean | `true` | short callouts (fed you, ...) |
| `whisper` | boolean | `false` | send warnings as whispers instead of public chat |
| `whenGone` | `stay` \| `home` | `"stay"` | player offline: wait where they were last seen (stay) or go home |
| `catchUp` | number (16..256) | `48` | player online but out of sight: walk to where they were last seen, up to this far |

### `guard_owner`

*combat · priority npc (20) · needs `guard`*

Stays near its owner (or a given player) and kills hostile mobs that come close to them, like the guard action but persistent: it picks up again after interruptions and restarts. Arm it as a bodyguard.

| option | type | default | description |
|---|---|---|---|
| `player` | string |  | who to protect; default the first owner online |
| `radius` | number (4..32) | `12` | fight mobs this close to them |

### `guard_area`

*combat · priority npc (20) · needs `attack` · uses `goto`, `wander` when present*

Defends an area (a remembered place, coordinates, or where it stands when armed): kills hostile mobs that enter it and patrols when quiet. Never attacks players or animals. Arm it to protect a base or farm.

| option | type | default | description |
|---|---|---|---|
| `place` | string |  | remembered place to guard (remember_place); default x/z, else home, else where it was armed |
| `x` | number |  | centre x |
| `y` | number |  | centre y |
| `z` | number |  | centre z |
| `radius` | number (4..48) | `12` | guard this far around the centre |
| `patrol` | boolean | `true` | walk around the area when it is quiet |

### `follow_owner`

*social · priority npc (20) · needs `follow` · uses `goto` when present*

Follows its owner (or a given player) at a distance whenever they are online and in sight, and walks to catch up (no teleporting) when they are far. Arm it when your owner wants you to come along.

| option | type | default | description |
|---|---|---|---|
| `player` | string |  | who to follow; default the first owner online |
| `distance` | number (1..16) | `3` | how close to stay, in blocks |
| `catchUp` | number (8..128) | `32` | beyond this, walk over with goto before following |

### `sleep_at_night`

*routine · priority npc (20) · needs `sleep` · uses `go_home` when present*

At night walks home (if a home is set) and sleeps in a bed there until morning. Needs a bed within 16 blocks of home.

| option | type | default | description |
|---|---|---|---|
| `homeRange` | number (1..64) | `8` | walk home first when farther than this |

### `return_home`

*routine · priority npc (20) · needs `go_home`*

Walks back home when it strays too far by day, and stays close to home at night. Needs a home (set_home).

| option | type | default | description |
|---|---|---|---|
| `maxDistance` | number (4..512) | `32` | head home when farther than this by day |
| `nightDistance` | number (2..128) | `6` | at night, head home when farther than this |

### `deposit_when_full`

*work · priority npc (20) · needs `deposit` · uses `goto_place`, `goto` when present*

When the inventory is nearly full, walks to a chest (a remembered place, coordinates, or the nearest one), stores everything except tools, armour, food and kept items, then walks back. Arm it for long gathering jobs.

| option | type | default | description |
|---|---|---|---|
| `threshold` | number (0.3..1) | `0.85` | share of inventory slots used that counts as full |
| `place` | string |  | remembered place where the chest is |
| `x` | number |  | chest x (with y and z) |
| `y` | number |  |  |
| `z` | number |  |  |
| `keep` | list | `[]` | items never to store |
| `returnBack` | boolean | `true` | walk back to where it was afterwards |

### `farm_setup`

*work · priority npc (20) · needs `start_farm`, `harvest`, digging · uses `craft`, `goto`, `breed` when present*

Makes the bot self-sufficient for food: when it has no farm it starts one (seeds from grass, a hoe, flat grass by water near home, outside protected areas and away from builds), then harvests and replants it when ripe, bakes bread from the wheat and breeds animals it has food for. By day only. Arm it on any bot that should feed itself long term.

| option | type | default | description |
|---|---|---|---|
| `place` | string |  | remembered place to farm near; default home, else where it is |
| `size` | integer (3..9) | `9` | plot side around one water block |
| `radius` | number (8..96) | `48` | how far from the centre to look for water |
| `fence` | boolean | `true` | fence the plot when it has the materials |
| `light` | boolean | `true` | put torches on the corners when it has torches or coal |
| `tend` | boolean | `true` | harvest and replant its farm when it is ripe |
| `tendRange` | number (16..512) | `128` | only walk to the farm from this close |
| `tendMinutes` | number (5..240) | `20` | check a farm that is out of sight this often |
| `minRipe` | integer (1..80) | `8` | harvest when at least this many crops are ripe |
| `bake` | boolean | `true` | bake bread from wheat |
| `breed` | boolean | `true` | breed animals it has food for (cows/sheep: wheat, pigs: carrots, chickens: seeds) |
| `keepWheat` | integer (0..64) | `4` | wheat to keep for breeding instead of baking |
| `maxHerd` | integer (2..64) | `12` | stop breeding a kind at this many adults |
| `spawnClearance` | number (0..256) | `48` | never farm within this distance of the world spawn |

### `farm_loop`

*work · priority npc (20) · needs `harvest` · uses `goto` when present*

Tends fields: every few minutes, when enough crops are ripe within the radius, harvests them, picks up the drops and replants. Arm it near a farm, or give it a remembered place (e.g. farm:1 from start_farm) to walk to.

| option | type | default | description |
|---|---|---|---|
| `radius` | number (2..32) | `16` | field radius around the bot (or the place) |
| `minRipe` | integer (1..64) | `4` | wait until at least this many crops are ripe |
| `everyMinutes` | number (0.5..240) | `5` | pause between rounds |
| `replant` | boolean | `true` | replant from the inventory |
| `place` | string |  | remembered place of the field (e.g. farm:1); default around the bot |

### `chop_wood_loop`

*work · priority npc (20) · needs `chop_tree`, digging*

Keeps a stock of wood: by day, while it has fewer than `keep` logs (4 planks count as one), it fells trees nearby, away from spawn and protected areas, and replants. Needs digging enabled.

| option | type | default | description |
|---|---|---|---|
| `keep` | integer (1..512) | `16` | logs to keep in stock |
| `radius` | number (4..64) | `32` | how far to look for trees |
| `spawnClearance` | number (0..256) | `48` | never chop within this distance of the world spawn |
| `replant` | boolean | `true` | plant saplings afterwards |

### `collect_drops`

*work · priority npc (20) · needs `pickup_items`*

Picks up dropped items lying nearby every so often (all items, or only the listed ones). Arm it while working so loot and drops don't despawn.

| option | type | default | description |
|---|---|---|---|
| `radius` | number (2..32) | `12` | pick up drops this close |
| `items` | list | `[]` | only these items, e.g. oak_log,wheat; empty = everything |
| `everySeconds` | number (2..600) | `15` | pause after a pickup run |

### `light_area`

*work · priority npc (20) · needs `place_block`, block placing · uses `craft` when present*

Places torches on dark ground around home (or a remembered place) so mobs do not spawn there, crafting torches from coal and sticks if needed. Only inside the given radius; never in protected areas.

| option | type | default | description |
|---|---|---|---|
| `place` | string |  | remembered place to light up; default home |
| `radius` | number (4..64) | `20` | only light within this distance of the centre |
| `darkBelow` | integer (1..15) | `8` | place a torch where block light is below this |
| `spacing` | integer (3..16) | `7` | no torch closer than this to another light |
| `craft` | boolean | `true` | craft torches from coal/charcoal and sticks when out |

### `keep_tools_upgraded`

*work · priority npc (20) · needs `upgrade_tools` · uses `craft` when present*

Keeps tools usable and moving up the tiers when the bot is idle: re-crafts a worn or broken pickaxe/axe/shovel/sword, makes stone tools as soon as it can mine 3 cobblestone, then a furnace, iron (smelted with coal or charcoal) and diamond tools, up to `upTo`. Gathering steps need digging enabled.

| option | type | default | description |
|---|---|---|---|
| `upTo` | `stone` \| `iron` \| `diamond` | `"iron"` | highest tier to work towards |
| `minDurability` | number (0..0.9) | `0.1` | replace a tool when less than this share of its durability is left |
| `armour` | boolean | `false` | also make iron armour once iron tools are done |
| `senseSeconds` | number (5..600) | `30` | how often to look around for stone and ore (the scan costs CPU) |

### `greet_players`

*social · priority idle (10)*

Says hello in chat, now and then, to players who come close (rate limited per player and overall). Flavour for NPCs.

| option | type | default | description |
|---|---|---|---|
| `radius` | number (2..32) | `8` | greet players this close |
| `perPlayerMinutes` | number (1..1440) | `30` | do not greet the same player again for this long |
| `globalMinutes` | number (0..1440) | `5` | pause after any greeting |
| `chance` | number (0..1) | `0.5` | chance to greet per encounter |
| `lines` | list |  | greetings; {name} is the player |

### `wander`

*idle · priority idle (10) · needs `wander`*

Takes short walks near home (or where it is) with pauses in between, when nothing else is going on.

| option | type | default | description |
|---|---|---|---|
| `radius` | number (1..64) | `12` | how far to wander by day |
| `nightRadius` | number (1..64) | `4` | how far to wander at night |

### `idle_look`

*idle · priority idle (10) · needs `look_around`*

Fidgets when there is nothing else to do: glances at nearby players or looks around, so it looks alive.

| option | type | default | description |
|---|---|---|---|
| `everySeconds` | number (2..120) | `8` | pause between glances |
| `radius` | number (2..32) | `10` | look at players this close |

### `idle_antics`

*idle · priority idle (10)*

When idle (standing around, nothing to do), now and then does something funny or strange: spins, crouch-dances, stares at the sky, hops, moonwalks, or mutters a line. Pure flavour; runs even while follow_owner is armed.

| option | type | default | description |
|---|---|---|---|
| `everySeconds` | list | `[40,120]` | random pause between antics [min, max] |
| `chat` | number (0..1) | `0.15` | chance an antic comes with a quip in chat (0 = never) |
| `antics` | list of spin, crouch_dance, sky_stare, bob, victory_hop, head_shake, moonwalk, stare_contest |  | which antics to use; default all |
| `quips` | list |  | custom chat lines |

### `anti_afk`

*idle · priority idle (10)*

Avoids idle (AFK) kicks: after some seconds without moving, looks around, swings an arm, sneaks or hops in place. Never walks.

| option | type | default | description |
|---|---|---|---|
| `afterSeconds` | number (5..600) | `45` | seconds without movement before a small action |
| `moves` | list of look, swing, sneak, hop |  | which moves to use; default all |

<!-- behaviors:end -->

## Writing your own

```ts
import { defineBehavior, BehaviorRegistry, defaultBehaviors, behaviorsBrain } from '../src/brains/behaviors/index.ts'
import { z } from '../src/core/index.ts'

const fishAtDawn = defineBehavior({
  name: 'fish_at_dawn',
  category: 'work',
  description: 'Goes fishing at the pond around sunrise. Arm it on a fisherman NPC.',
  options: z.object({
    place: z.string().default('pond').describe('remembered place to fish at'),
    minutes: z.number().min(1).max(10).default(2).describe('how long to fish')
  }),
  requires: ['fish', 'goto_place'],
  priority: 'npc',
  create: (o) => ({
    cooldownMs: 10 * 60_000,
    score: ({ bb }) => bb.facts.timeOfDay > 23000 || bb.facts.timeOfDay < 1500 ? 35 : 0,
    async run (ctx) {
      const there = await ctx.act('goto_place', { name: o.place })
      if (!there.ok) return there
      return ctx.act('fish', { minutes: o.minutes })
    }
  })
})

behaviorsBrain({ registry: new BehaviorRegistry([...defaultBehaviors(), fishAtDawn]) })
```

- `options` is a zod object with defaults and `.describe()` texts; unknown keys are
  rejected. `behavior_list` and the generated docs read it.
- `create(options, { agent })` returns the NPC behaviour body (`score`, `run`, cooldowns).
  Act only through `ctx.act()` (caller `brain:behaviors`, the behaviour's priority); read
  the world freely. See [NPC brain](npc-brain.md#writing-a-behaviour) for scoring bands.
- `hook(options)` returns a per-tick hook instead (that's how `greet_players` works).
- `prepare(options, { agent, player })` fills context-dependent options when armed from an
  action, e.g. `guard_area` takes the bot's position as the centre.
- Keep decisions pure where you can (`nextFoodStep`, `assessDanger`) and unit-test them
  with a fake world; see `test/behaviors.test.ts`.
- With a custom registry, the CLI still validates a profile's `behaviors:` against the
  built-in library, so extend it rather than replacing it.

## Debugging

- `!behavior_status`: armed set with non-default options, what runs, last outcome per
  behaviour, cooldowns and back-off. The result `data` has the full JSON.
- `-l info,<bot>/behaviors=debug` logs every start, switch, stop, back-off and cooldown.

## NPC mode (when the LLM can't think)

An LLM + NPC bot keeps playing when its LLM is paused: the provider's quota is used up ("weekly
limit · resets 12pm"), or its own token budget ran out. While paused it arms extra behaviours
and disarms exactly those again when the LLM is back (at the reset time, or when the budget
frees up). The default set is `chop_wood_loop` and `deposit_when_full` (going home at night is
`stay_safe`'s job); behaviours that were already armed are left alone.

```yaml
npcMode:                 # profile key; false turns it off
  arm:
    farm_loop: {}
    guard_area: { radius: 24 }
```

A quota pause is kept in storage, so reconnects and restarts don't start failing turns, and the
bot's `observe()` (`self.mode`) says it's in NPC mode. `!` commands work the whole time.

In NPC mode owners can still steer the bot in plain chat ("pax guard me", "pax start farming"):
the [intents brain](/guide/intents) arms and disarms behaviours without the LLM. See [plain-language commands](./intents).
