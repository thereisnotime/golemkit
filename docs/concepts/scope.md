# What is game-specific

golemkit plays Minecraft Java, but a lot of it has nothing to do with Minecraft: the LLM brain,
plain-language commands, the action lock, brains sharing one body, behaviours, the journal,
logging, live config and fleets. The [game-adapter proposal](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md)
splits the code into a game-agnostic core and game adapters (Minecraft Java first, then Bedrock
or Luanti, see the [roadmap](/roadmap#games)). This page says, for every directory, which side
it is on today and where it would go.

## The four scopes

Every docs page carries one of these badges at the top. Click it to come back here.

| badge | meaning |
|---|---|
| <span class="scope-badge core">Game-agnostic</span> | No Minecraft in it. Stays in the core after the split and works with any adapter. |
| <span class="scope-badge minecraft">Minecraft-specific</span> | Built on Mineflayer or on Minecraft rules (blocks, items, mobs, recipes). Moves to the Minecraft Java adapter. |
| <span class="scope-badge neoforge">NeoForge-specific</span> | Only matters on NeoForge servers: the mod handshake and wire formats. Part of the Minecraft Java adapter. |
| <span class="scope-badge mixed">Mixed</span> | A game-agnostic mechanism with Minecraft parts. The note next to the badge says which parts. |

Pages set the scope in their frontmatter:

```yaml
---
scope: mixed            # core | minecraft | neoforge | mixed
scopeNote: "Goals are game-agnostic; building is Minecraft."
---
```

## By directory

Counts come from reading the imports, with `node scripts/scope-check.ts` (see
[below](#checking-it-yourself)). **import** is the number of files that import `mineflayer*`,
`prismarine-*`, `minecraft-*` or `vec3`; **bot use** is the number that reach into the Mineflayer
bot directly (`agent.bot`, `ctx.bot`, `bot.entity`, `bot.inventory`, ...). A file can do both.
The **after the split** column follows the [design](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/design.md):
*core*, *adapter* (the `adapters/minecraft-java` package) or *adapter skill* (actions an adapter
ships through `defineAction`).

| directory | files | import | bot use | scope | why | after the split |
|---|---|---|---|---|---|---|
| `src/core/` (top level) | 19 | 9 | 4 | mixed | `danger`, `events`, `fleet`, `fleetFile`, `log`, `profile`, `retry`, `storage`, `toggles` and `index` are clean. `agent.ts` wraps the Mineflayer bot and pathfinder; `action`, `brain`, `skill`, `definition` only import its types; `helpers` (goto, holdGoal), `humanize` and `protection` drive the bot; `modded` patches prismarine-block for modded blocks. | core, with `agent`, `helpers`, `protection`, `modded` and the Mineflayer half of `humanize` moving to the adapter; the type imports become adapter interfaces |
| `src/core/journal/` | 13 | 1 | 2 | mixed | Storage, aggregation, rollups and queries are plain data. `capture.ts` subscribes to Mineflayer events (death, health, inventory, dig, place). The second bot-use hit, `journal.ts`, only stores the bot's name. | core, with capture split: agent events in core, game events from the adapter's `on()` |
| `src/core/neoforge/` | 5 | 2 | 0 | neoforge | The NeoForge configuration-phase handshake, registry sync and channel store; `codec.ts` uses prismarine-nbt, `handshake.ts` hooks minecraft-protocol. | adapter (minecraft-java) |
| `src/llm/` (with `providers/`, `eval/`) | 25 | 0 | 2 | core | Providers, prompts, goals, budgets, quota pause, pricing, usage, MCP bridge. Only `runtime.ts` (online player check, danger check before resuming) and `tools.ts` (observe, safety check on health, food, time, hostiles) peek at the bot through `as any`. | core; those two reads go through the adapter's `self()` and `observe()` |
| `src/context/` | 6 | 0 | 0 | core | Context packs, memory files, procedures and hooks are markdown and YAML. | core |
| `src/brains/` (top level) | 5 | 0 | 3 | mixed | `command.ts` is game-agnostic. `llm.ts` and `hooks.ts` listen to bot events and read health, inventory and position; `reflexes.ts` is Minecraft combat and eating. | core for `command`, `llm`, `hooks` (events via the adapter); `reflexes` to the adapter |
| `src/brains/intents/` | 10 | 0 | 1 | mixed | The parser, layers, pipeline and slots are text processing; the pattern table names Minecraft actions and items, and `brain.ts` reads the bot for context. | core pipeline; the pattern table and slot vocabulary become adapter data |
| `src/brains/npc/` | 13 | 3 | 5 | mixed | `select.ts` (utility scoring) is generic. `blackboard`, `controller` and `types` are typed against the Mineflayer bot; stock behaviours (danger, eat, social) read its state. | core controller and scoring; stock behaviours to the adapter |
| `src/brains/behaviors/` | 19 | 8 | 10 | mixed | Arming, registry, runtime, config and the behaviour actions are generic. The `library/` (keep_fed, bodyguard, farm, tools, safety, work, social, routine, fun) is all Minecraft. | core for the framework; the library becomes adapter skills, gated by capabilities |
| `src/brains/scene/` | 10 | 0 | 2 | mixed | Casting, beats, lines, the director protocol and scheduling are generic; `actions.ts` and `runtime.ts` move actors and read positions through the bot. | core, with movement and positions through adapter actions |
| `src/brains/self/` | 9 | 2 | 2 | mixed | The program format, gate, interpreter, learner and store are generic; `brain.ts` and `compile.ts` evaluate conditions on the Mineflayer bot (health, time, mobs). | core, with conditions read from the adapter's observation |
| `src/skills/` | 45 | 26 | 33 | minecraft | Actions for movement, combat, food, mining, crafting, building, roads, WorldEdit. 34 of 45 import Mineflayer or drive the bot; the rest (`blueprint`, `*-plan`, `tactics`, `blockstate`, `config`, ...) are pure logic over Minecraft data. `config` is game-agnostic and `journal` nearly so. | adapter skills; `config` and the journal actions move to core |
| `src/cli.ts` | 1 | 0 | 0 | core | Argument parsing, run, fleet, list. | core |
| `variants/` | 5 | 0 | 0 | minecraft | No direct imports, but every variant picks Minecraft skills, reflexes and settings. | adapter examples (with re-exports so they keep working) |
| `profiles/` | YAML | | | mixed | The keys are generic (brains, LLM, listen modes); values name Minecraft items, blocks and behaviours, and `profiles/pax/` context packs mention Minecraft play. | stays; values are per adapter |
| `scripts/` | 25 | 0 | 13 | mixed | Live tests and benchmarks (`guard-bench`, `fight-test`, `build-test`, ...) drive a real bot on a Minecraft server; `gen-docs`, `docs-interlink`, `llm-*` and `scope-check` are generic. | live tests per adapter; the rest stays |
| `blueprints/` | YAML | | | minecraft | Block palettes and schematics imported from Minecraft formats. | adapter data |

Totals: in `src/core/` as a whole, 13 of 37 files import Mineflayer or touch the bot; in
`src/llm/`, 2 of 25; in `src/context/`, none; in `src/skills/`, 34 of 45. The proposal quotes
17 of 36 core files and 38 of 45 skill files, which counts more patterns (anything that uses a
Minecraft type or name); either way the shape is the same.

## Rules for new code

- Game-agnostic code (core, LLM, context, the brain frameworks) must not import `mineflayer`,
  `prismarine-*`, `minecraft-*` or `vec3`, and must not touch `agent.bot`. If it needs the
  game, it calls an action through `agent.act()` or listens to agent events.
- Minecraft-specific code goes in a skill (`src/skills/`) or, for the server handshake, in the
  NeoForge layer (`src/core/neoforge/`).
- When a page covers both, mark it `mixed` and say which parts are which in `scopeNote`.

The same rules are in `AGENTS.md`, so coding agents follow them too.

## Checking it yourself

```bash
just scope-check                      # per-directory counts, plus imports outside the expected places
node scripts/scope-check.ts --files   # every file that imports a Minecraft package or touches the bot
```

It is informational and always exits 0. The expected places for Minecraft imports are
`src/skills/`, `src/core/neoforge/` and `scripts/`; everything else it lists is a candidate for
the adapter move. Once the split lands, the proposal turns this into a lint rule.
