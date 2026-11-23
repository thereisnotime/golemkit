---
scope: core
---

# What is game-specific

golemkit plays Minecraft Java, but a lot of it has nothing to do with Minecraft: the [LLM brain](/guide/llm-brain),
[plain-language commands](/guide/intents), the [action lock](/concepts/architecture#the-action-lock-and-priorities), brains sharing one body, behaviours, the [journal](/guide/journal),
logging, live config and [fleets](/concepts/architecture#fleets-and-multiple-servers). The [game-adapter proposal](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md)
splits the code into a game-agnostic core and game adapters (Minecraft Java first, then Bedrock
or Luanti, see the [roadmap](/roadmap#games)). This page says, for every directory, which side
it is on.

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
Comment lines don't count. Phases 0 to 3 of the
[design](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/design.md)
are done: the Minecraft side moved into `src/adapters/minecraft-java` (see
[Game adapters](./adapters.md)) and the game-agnostic directories are clean.

| directory | files | import | bot use | scope | what's in it |
|---|---|---|---|---|---|
| `src/core/` (top level) | 20 | 0 | 0 | core | Agent lifecycle, action lock, chat queue, storage, toggles, danger zones, logging, fleets, [profiles](/guide/profiles), the trip planner (`trip.ts`), and `adapter.ts` (the GameAdapter interface and capabilities). `index.ts` still re-exports the Minecraft helpers (`goto`, `goals`, `isHostile`, ...) so [variants](/concepts/variants-profiles) and scripts keep their imports. |
| `src/core/journal/` | 14 | 0 | 0 | core | Storage, aggregation, rollups, queries and death reports (death message parsing, cause tracking); the capture of game events moved to the adapter. |
| `src/adapters/minecraft-java/` | 42 | 24 | 28 | minecraft | `adapter.ts` (Mineflayer, pathfinder, session events), helpers, modded blocks, refusal watch, journal capture, [reflexes](/concepts/world#reflexes), the behaviour library, the stock NPC behaviours, the [scene](/guide/scenes) actions, and the server platforms (`platforms/neoforge`, `vanilla`, `paper`). |
| `src/llm/` (with `providers/`, `eval/`) | 25 | 0 | 0 | core | Providers, prompts, goals, budgets, quota pause, pricing, usage, MCP bridge. The online check and the danger check go through the adapter. |
| `src/context/` | 6 | 0 | 0 | core | [Context packs](/guide/context-pack), memory files, procedures and hooks are markdown and YAML. |
| `src/brains/` (top level) | 4 | 0 | 0 | core | `command`, `llm`, `hooks` (game events through `agent.adapter`), `index`. Reflexes moved to the adapter. |
| `src/brains/intents/` | 10 | 0 | 0 | mixed | The parser, layers, pipeline and slots are text processing; the pattern table names Minecraft actions and items. |
| `src/brains/npc/` | 11 | 0 | 0 | core | Controller, blackboard (reads the adapter's world view), utility scoring and the help desk (`help.ts`, asking owners when a behaviour keeps failing); generic stock behaviours (wander, home, sleep, action). |
| `src/brains/behaviors/` | 8 | 0 | 0 | core | Arming, registry (with capability gating), runtime, config and the behaviour actions. |
| `src/brains/scene/` | 9 | 0 | 0 | core | Casting, beats, lines, the director protocol and scheduling; positions and hits through the adapter. |
| `src/brains/self/` | 9 | 0 | 0 | core | Program format, gate, interpreter, learner and store; conditions read the adapter's world view. |
| `src/skills/` | 69 | 35 | 42 | minecraft | Actions for movement, combat, food, mining, crafting, building, roads, [WorldEdit](/guide/worldedit), each with the capabilities it needs, plus pure planners (`foodPlan`, `farmPlan`, `searchPlan`, `reachPlan`, `ranged-plan`, `techniques`, `pvp`, ...) that touch no bot. `config` is game-agnostic and `journal` nearly so. |
| `src/cli.ts` | 1 | 0 | 0 | core | Argument parsing, run, fleet, list. |
| `variants/` | 5 | 0 | 0 | minecraft | No direct imports, but every variant picks Minecraft skills, reflexes and settings. |
| `profiles/` | YAML | | | mixed | The keys are generic (brains, LLM, listen modes); values name Minecraft items, blocks and behaviours. |
| `scripts/` | 36 | 1 | 21 | mixed | Live tests and benchmarks (`guard-bench`, `pvp-bench`, `survival-bench`, `smoke-test`, `fight-test`, ...) drive a real bot on a Minecraft server (`pvp-bench` also imports `minecraft-protocol`); `gen-docs`, `parity`, `adapter-lint`, `scope-check` and `llm-*` are generic. |
| `blueprints/` | YAML | | | minecraft | Block palettes and [schematics](/guide/blueprints#import) imported from Minecraft formats. |

Before the split (v0.1.0), 13 of 37 files in `src/core/` and 24 of 66 in `src/brains/`
imported Mineflayer or touched the bot; now none do, and the adapter holds 33 of its 42.

## Rules for new code

- Game-agnostic code (core, LLM, context, the brain frameworks) must not import `mineflayer`,
  `prismarine-*`, `minecraft-*` or `vec3`, and must not touch `agent.bot`. If it needs the
  game, it calls an action through `agent.act()`, listens to agent events or reads
  `agent.adapter` (self, entities, time, events).
- Minecraft-specific code goes in a skill (`src/skills/`, with the `capabilities` it needs) or
  in the adapter (`src/adapters/minecraft-java/`; the server handshake in its NeoForge platform).
- When a page covers both, mark it `mixed` and say which parts are which in `scopeNote`.

The same rules are in `AGENTS.md`, so coding agents follow them too.

## Checking it yourself

```bash
just scope-check                      # per-directory counts, plus imports outside the expected places
node scripts/scope-check.ts --files   # every file that imports a Minecraft package or touches the bot
just lint-adapters                    # the rule as a check (part of just check): fails on a hit
```

`scope-check` is informational and always exits 0. The expected places for Minecraft imports are
`src/adapters/`, `src/skills/` and `scripts/`. `lint-adapters` (`scripts/adapter-lint.ts`)
fails on a Minecraft import or direct bot use in `src/core`, `src/llm`, `src/context`,
`src/brains` or `src/cli.ts`.
