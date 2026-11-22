---
scope: minecraft
---

# Movement, protection and combat

How bots get around, what they learn about the world, and how they fight. These live in core
and the standard skills, so every [variant](/concepts/variants-profiles) gets them.

## Long-distance travel

Mineflayer's pathfinder can only plan through chunks the bot has loaded, so a target thousands
of blocks away used to "arrive" without moving. `travel()` (core helper, used by `goto`) walks
in legs:

```mermaid
flowchart TD
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
- It watches the bot's air: the pathfinder walks along lake beds and a sinking bot drowns, so
  below 12 of 20 air the walk stops, the bot swims straight up, and the trip carries on (after the
  third time it gives up with "kept running out of air under water").
- [Retries](/guide/profiles#retries) (`retry.actions.goto`) re-run it after "stuck" failures.

```ts
await travel(bot, { x: 640, z: 60 }, signal, { stepBlocks: 64, onProgress: p => log.debug('travel', p) })
```

## Protected areas

Servers refuse block breaking in some places (spawn protection, claims). A refused break looks
like success to mineflayer: it marks the block as air, then the server restores it. Bots learn
these areas instead of looping:

```mermaid
---
config:
  sequence:
    width: 110
    actorMargin: 30
    diagramMarginX: 10
---
sequenceDiagram
  autonumber
  participant B as Bot
  participant S as Server
  participant P as protectedAreas
  participant PF as Pathfinder
  B->>S: dig dirt at 545 70 45
  S-->>B: block_change:<br/>dirt is back
  B->>P: markProtected(545 70 45)
  P->>P: new zone (radius 20),<br/>save data/<br/>protected-host-port.json
  P->>PF: digging inside<br/>zones costs ∞,<br/>re-plan now
  Note over B,PF: collect / chop_tree skip blocks in zones,<br/>walk out once if everything nearby<br/>is protected
```

- Zones are saved per server and loaded on every start, for every bot on that server.
- `agent.protectedAreas.isProtected(pos)`, `agent.markProtected(pos)` from code.
- `digBlock()` (skills/world.ts) throws `DigRefusedError` on a refusal; skills that dig use it.
- Only the dug block coming back counts. NeoForge echoes the block when digging starts and then
  sends air, and a creative build places the next block into a dug cell within 200 ms: neither
  is a refusal. In creative a sword (or trident, mace) is put away before digging, since a
  creative player can't break blocks with one.
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

## Weapons

`fight()` picks what to hit with for each target and re-checks before every swing
(feature flags `combat.*`, live via [`!config_set`](../guide/live-config)):

- **adaptive melee** (`combat.adaptiveWeapon`): scores swords, axes, tridents, maces and tools by
  damage × attack speed with enchantments that apply to this target (Sharpness everywhere,
  Smite vs undead, Bane of Arthropods vs spiders); switches to the hardest single hit when one
  hit kills, and to an axe against shield users. Off: the old fixed sword > axe order.
- **ranged** (`combat.ranged`): with a bow or crossbow and arrows, shoots flyers (phantoms,
  ghasts) and targets more than 6 blocks away, leading moving targets.
- **ranged aim**: arrows are aimed with real arrow physics (gravity 0.05, drag 0.99 per tick)
  and lead the target by its velocity, measured while the bow draws.
- **shield** (`combat.shield`): raises a shield against skeletons, pillagers, blazes and other
  ranged mobs while closing in, and between swings at point-blank archers. A shield already in
  the offhand counts (it used to be missed).

Unknown modded weapons count as a generic sword/axe by name.

## Fighting

`fight()` (loop in `src/skills/fight.ts`, pure decisions in `src/skills/tactics.ts`) runs at
50 ms ticks:

```mermaid
flowchart TB
  P(["defend: threats around"]) --> T["pick target<br/>lit/close creeper ›<br/>archer in sight ›<br/>nearest melee<br/>(never players, villagers,<br/>golems, pets, named;<br/>neutral mobs only<br/>while they attack)"]
  T --> L{"stop?<br/>outnumbered,<br/>health ≤ 4 with food,<br/>chased past maxChase,<br/>water/lava/drop/<br/>dark cave,<br/>no progress 3 s"}
  L -- no --> M["melee step<br/>(below)"]
  M --> L
  L -- "health ≤ 4,<br/>food" --> H["back off, eat,<br/>re-engage"]
  L -- outnumbered --> O["pillar 2 and hit<br/>from the top,<br/>or go home,<br/>or back off"]
  L -- "archer out<br/>of reach" --> LOF["back out of its<br/>line of fire"]
  H --> T
  H ~~~ LOF
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef v fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  class P,T a
  class L d
  class M v
  class H g
  class O,LOF r
```

Each melee step:

```mermaid
flowchart TB
  M(["melee step"]) --> R{"in reach?<br/>eyes → hitbox ≤ 3"}
  R -- no --> A["approach<br/>pathfinder far,<br/>steer close by;<br/>archers: zig-zag<br/>or shield;<br/>spider on a wall: wait"]
  R -- yes --> C{"charged?<br/>1 / attack speed"}
  C -- "first hit" --> SK["sprint hit<br/>(knockback)"]
  C -- "≤ 300 ms left" --> J["jump"]
  J --> F["falling + charged:<br/>crit ×1.5"]
  C -- "not yet" --> S["spacing<br/>&lt; 2.2 back,<br/>&gt; 2.9 forward,<br/>else strafe<br/>(safe steps only)"]
  SK --> B["step back out<br/>of its swing"]
  F --> B
  B --> S
  S --> E{"lull and<br/>hungry?"}
  E -- yes --> EAT["eat"]
  A --> BK(["back to stop?"])
  E -- no --> BK
  EAT --> BK
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef v fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  class M,A,BK a
  class R,C,E d
  class SK,J,F,B,S v
  class EAT g
```

- **Timing**: the swing waits for the held weapon's full charge (sword 625 ms, iron axe 1.1 s,
  stone axe 1.25 s). Switching items resets the charge, so the timer restarts too.
- **Crits** (`combat.crits`): jump when the charge has ≤ 300 ms left, hit once falling. Not in
  water, not under a low ceiling, not against a creeper (no time). The first hit of a fight is a
  sprint hit for knockback instead.
- **Spacing** (`combat.strafe`): zombies reach about 1.4 blocks between centres, the bot 3 blocks
  from its eyes. It keeps 2.2 to 2.9 blocks, strafes between swings, steps back after a hit.
  Every step is checked: no water, lava or fire, no drop over 2 blocks.
- **Archers**: shot with a bow when it has arrows; otherwise approached in a zig-zag sprint, or
  behind a raised shield. When it can't get closer for 3 s it backs out of the line of fire.
- **Spiders** on walls aren't followed; it waits on the ground for them to drop.
- **Chase limit** (`combat.maxChase`, default 16): measured from where the run of fights started
  (kept until 20 s pass without a fight), and `defend` walks back there afterwards, so reflex
  fights don't drag the bot away from shelter.
- **Creepers first**: a creeper coming within 5 blocks ends the current fight so it gets dealt
  with before its fuse. With a bow and arrows it shoots a creeper from 5+ blocks (not when a
  bodyguard's player is in the line); otherwise it hits once and steps back. A lit fuse within 5
  blocks sends it 7 blocks away until the fizzle (`creeperMove` in `tactics.ts`).
- **Outnumbered** (3+ melee mobs within 6, health under half): pillar 2 blocks (zombies can't
  reach feet that high, the bot still reaches their heads) and fight from the top; without
  blocks, go home if it is within 48 blocks, else back off.
- **Sustain**: in a lull (nothing within 4 blocks) it eats when hunger blocks regeneration
  (food < 18), or a golden apple when health ≤ 10. With `combat.disengageToHeal` (default on)
  and health ≤ 4 it backs off ~10 blocks, eats (or, with a full hunger bar, waits a few seconds
  for natural regeneration) and re-engages, even with `retreatBelow: 0`. Standing ground doesn't mean dying.
- **Gear** (`combat.autoArmor`, default on): the reflexes run `gear_up` whenever the inventory
  holds better armour than what is worn (armour points, toughness, Protection; nearly broken
  pieces don't count), and put a totem (health ≤ 10 or no shield) or a shield in the offhand.
  Before this, bots crafted iron armour and never wore it.
- **Reacting**: reflexes start `defend` when hurt (also on any health drop, the backstop for a
  missed hurt event), and before the first hit when a creeper is within 7 blocks or any hostile
  within 4. Shooters out of reach get `ranged_defense` instead, see [Ranged threats](#ranged-threats).
- **Night**: `stay_safe` heads home at night with higher priority when the bot has no armour,
  weapon or food; without a home it digs in with `bunker` until morning (needs digging, not
  under a roof already).

Two live benchmarks: `scripts/fight-test.ts` stands the bot outside for a night and counts kills,
deaths and damage taken; `scripts/arena-test.ts` uses an op account to hand out the same gear
after every death and summon the same waves of mobs (2 zombies, a skeleton, a spider, a creeper
every other wave), so runs of different versions compare directly.

## Ranged threats

Skeletons, strays, bogged, pillagers, witches, blazes, ghasts and drowned holding a trident shoot
from range, so waiting for the first hit (or walking on through the fire) is how bots died. Pax,
starving at food 0 on a find_food leg, was shot by a pillager near its base and only reacted to
the last bolt: the health-drop backstop ignored every drop at food 0 as starvation, and nothing
looked at shooters further than 8 blocks.

Every bot with the combat skill now keeps a ranged watch (`skills/ranged.ts`):

- **Shooters**: those within 24 blocks with a clear line between the bot's eyes and theirs, or
  that hurt it in the last few seconds. A shooter in its range with a line to the bot and looking
  at it counts as aiming.
- **Projectiles**: each arrow, bolt, trident, thrown potion or fireball near the bot is simulated
  forward (gravity and drag per tick, from the spawn packet's velocity or position samples);
  one that passes through the bot's body is an alarm before it lands. The spawn packet names the
  owner, so the shooter is known; arrows from players don't count.
- **Hits from range**: damage events name the shooter. A health drop the event didn't explain
  is blamed on a shooter with a line to the bot, even at food 0, so starving no longer hides a
  pillager.
- **Patrols**: pillagers, vindicators, evokers and ravagers within 24 are counted.

The `ranged_defense` action (reflex priority, so it preempts whatever job runs: find_food,
find_target, chop_wood_loop; they resume afterwards) answers with `rangedResponse` in
`ranged-plan.ts`:

```mermaid
flowchart TB
  A(["shot at, arrow on course,<br/>or a shooter aiming"]) --> L{"health ≤ 8?"}
  L -- yes --> H["hide"]
  L -- no --> O{"3+ shooters or a patrol of 3+,<br/>no iron armour + shield?"}
  O -- yes --> H
  O -- no --> B{"bow or crossbow<br/>and arrows?"}
  B -- yes --> S["shoot back"]
  B -- no --> SH{"shield?"}
  SH -- yes --> C["shield up, close in"]
  SH -- no --> CH{"weapon, health ≥ 14,<br/>≤ 2 shooters?"}
  CH -- yes --> Z["charge in a zig-zag"]
  CH -- no --> H
  H --> CV{"cover within 8?"}
  CV -- yes --> CO["walk behind the block,<br/>eat there, fight what walks up"]
  CV -- no --> R["back out of range,<br/>straight away from them"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class A a
  class L,O,B,SH,CH,CV d
  class S,C,Z g
  class H,CO,R r
```

- **Cover** (`findCover`): a standable spot within 8 blocks (2 up or down) where a solid block
  is on the line from the bot's head and chest to every shooter's eyes, cheapest first by walking
  distance, with a penalty for walking towards them or ending within 4 blocks of one. If a
  shooter comes round and sees it again it looks for new cover; one walking up within 4 blocks
  is fought there.
- **Eating**: only out of every shooter's sight with nothing in flight at it (`canEatUnderFire`),
  never standing in the open.
- **Ghasts** without a bow, and **blazes** without a bow or shield: cover.
- A melee mob within 3 blocks is fought first; a `defend` already running is only taken over to
  hide, and a bodyguard's `protect` only at 6 health or less.
- `stay_safe` adds a `ranged` danger (score 91, above a starving keep_fed's 90) when a shooter
  has a line to the bot and it is at 12 health or less, or outnumbered without good gear: it runs
  `ranged_defense` in cover mode. Option `ranged` (default on); reflexes have `rangedDefense`.

Flat open ground has no cover, so there the answer is backing off; the bot doesn't build cover
(placing a block wall) yet.

## Reflexes

The `reflexes()` brain reacts at the highest brain priority (60), preempting everything and
letting long-running actions resume afterwards.

Climbing out of a cave (`climb_out`, also when `goto` starts underground) is the exception:
while the bot climbs, an attacker that can't hit it in melee (an archer, a mob below the
pillar, one still a few blocks off) doesn't start `retreat` or `defend`; going on up is the
escape (`keepClimbing` in `survival.ts`). A zombie right on it, or a creeper close by, is
fought as usual. A fight that does preempt `goto` pauses the climb rather than failing it:
`goto` ends as preempted, and when it resumes it climbs again from wherever the bot is (two
climbs per run before it gives up).

```mermaid
flowchart TB
  H(["bot got hurt"]) --> M{"hostile within 8<br/>(flyers: 20)?"}
  M -- no --> X(["ignore"])
  M -- yes --> R{"retreat?<br/>health ≤ retreatBelow, or<br/>mob in water and health<br/>&lt; waterFightAbove<br/>(never for flyers)"}
  R -- yes --> RT["retreat: back off 18 blocks"]
  R -- no --> DF["defend: fight it"]
  T(["every 2 s"]) --> LOW{"health ≤ 4, mob close,<br/>food<br/>(disengageToHeal)?"}
  LOW -- yes --> DF
  LOW -- no --> G{"better armour,<br/>shield or totem?<br/>(autoArmor)"}
  G -- yes --> GU["gear_up<br/>(beside the current action)"]
  G -- no --> E{"food &lt; eatBelow<br/>or hurt and safe?"}
  E -- yes --> EAT["eat best food"]
  RT ~~~ T
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class H,T a
  class M,R,E,LOW,G d
  class DF,EAT,GU g
  class RT r
  class X a
```

Tune per variant (`reflexes({ ... })`) or per [profile](/guide/profiles):

```yaml
reflexes:
  selfDefense: true
  autoEat: true
  eatBelow: 15          # eat when food drops below this
  retreatBelow: 8       # back off at or below this health; 0 = stand your ground
  waterFightAbove: 14   # don't fight mobs in water below this health; 0 = always fight
  rangedDefense: true   # shoot back / shield / cover / back off when mobs shoot at it
```

Pax uses `retreatBelow: 0` and `waterFightAbove: 0`: it always fights back. It still backs off
briefly to eat at 4 health or less when it has food (`combat.disengageToHeal`), see
[Fighting](#fighting).

```yaml
combat:                 # all live via !config_set combat.*
  adaptiveWeapon: true
  ranged: true
  shield: true
  crits: true           # jump-crits, sprint into the first hit
  strafe: true          # spacing and strafing between swings
  disengageToHeal: true # back off to eat at <= 4 health when there is food
  autoArmor: true       # wear the best armour, shield/totem in the offhand
  maxChase: 16          # give up a chase this far from where the fight started
```

## Phantoms: bunker

Phantoms fly, so a bot without a weapon can't win against them. When phantoms attack at night
and the bot is unarmed or hurt (and can dig, outside protected areas), reflexes run `bunker`:
dig straight down 3 blocks, seal the hole with a dug block, wait for morning (or until the mobs
leave), climb back out with `climb_out` (dig the block above, jump, place a block underneath, until open sky), and check it really is back at the surface. It won't start when the bot is already under cover. Players and LLMs can call `bunker` and `climb_out` too.

## Tools, stone and wood

Bots climb the tool tiers on their own: stone tools as soon as there is a wooden pickaxe and
three cobblestone, then a furnace, iron (smelted with coal, planks or charcoal) and diamond
tools when diamonds turn up. Stone comes from a safe staircase and strip mine instead of
pathing to buried blocks (never straight down, never next to lava or water), and tall trees are
climbed so no logs stay up there. The upgrade path, the safety checks and how speed is measured
are in [Tool progression and gathering](../guide/progression).

## Whose blocks

By default bots may dig and use **any** block they need (`respectBuilds` off). With
`respectBuilds: true` (profile key, or `!config_set respectBuilds on`) `build` refuses footprints
with blocks that look player-made, unless they're the bot's own work (remembered in `build.own`)
or an owner passes `replace=true`. Spawn protection applies either way: the server enforces it.

Other places still prefer natural sources whatever the setting: woodcutting fells real trees,
strip mining digs natural stone, farm sites avoid builds.

## Travel stays on the surface

Long trips (`travel`, used by `goto`, scouting and going home) go in legs of about 64 blocks. Each
leg aims at the **open-sky ground height** at its waypoint (surface legs), not just at x/z: with
digging allowed, an x/z-only goal let the pathfinder tunnel straight through the terrain or drop
into ravines. A leg that ends up more than 12 blocks below both its start and its target under a
roof stops with `TravelUndergroundError`.

`goto` then climbs out (`climb_out`: dig up and pillar, or carve stair steps without blocks) and
tries again; it also climbs out first when it starts deep under a roof on a trip of more than 24
blocks. A fight pauses the climb instead of cancelling it.

## Falling and drops

The pathfinder never plans drops over 4 blocks, also not into water (mineflayer allows any
height into water by default; off here). Scouting legs aim at the open-sky ground and climb out
with `climb_out` when a leg ends up in a cave or ravine. Death whispers say how many items
dropped (or that there were none); `goto_death` refuses traps where it died twice in 10 minutes.

## Game modes

Bots know their game mode (`gameMode` and a short `gameModeNote` in `observe()`) and notice
when it changes (`gameModeChanged` event).

| mode | what changes |
|---|---|
| survival | everything as described on this page |
| creative | no hunger or damage: reflexes, `keep_fed` and `stay_safe` switch off; `creative_get` puts any item in the inventory; building takes items from the creative inventory instead of gathering; `upgrade_tools` takes the tools instead of mining |
| adventure | hunger and damage apply; breaking/placing is limited by the game |
| spectator | can only fly and watch |

## Where this shows up elsewhere

- Deaths, damage and protected areas are recorded in the [journal](../guide/journal).
- [Humanize](../guide/profiles#humanize-player-like-timing) adds reaction and typing delays on
  top of all of this for immersive bots.
- Modded item and mob names come from the [NeoForge registry sync](./neoforge).
