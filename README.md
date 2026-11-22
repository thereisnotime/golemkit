# golemkit

A TypeScript framework for building Minecraft Java bots, with first-class **NeoForge** support: companions,
bodyguards, self-sufficient NPCs and LLM-driven agents, all from the same pieces (actions,
skills, brains, behaviours, profiles). Bots are real protocol clients built on
[Mineflayer](https://github.com/PrismarineJS/mineflayer), not headless Minecraft, so they
start in a second and use ~100 MB each.

Built and tested on the **mc02** NeoForge 1.21.1 modpack (Create, Ars Nouveau, Curios, ...).
The NeoForge layer learns any server's mod channels on its own and stays idle on vanilla and
Paper servers. See [what's supported](#support-status) for what has been tested.

## What the bots can do

- **Talk to them in plain chat.** "pax follow me", "guard me", "find iron", "bring me 16
  planks", "chop some wood". A layered intent pipeline (patterns, a local MiniLM embedding
  model, an optional local LLM, then the cloud LLM) handles it, and each layer can be switched,
  reordered, tuned live and benchmarked. Works with no LLM at all.
- **Run on an LLM when you want one.** Claude or Codex on your subscription, or an API. Goals
  they work through on their own, budgets, quota pauses, and an NPC fallback mode when the
  quota runs out.
- **Look after themselves and you.** Reflexes (fight back, eat, escape), adaptive weapons,
  shields, crits, a bodyguard behaviour that protects its owner, tool upgrades, food scouting,
  farming, climbing out of caves, swimming up when low on air.
- **Find and fetch.** Search for ores, mobs, water, villages or biomes, then bring items from
  their own chests, crafting, smelting or gathering, and recover an owner's drops after a death.
- **Build.** YAML blueprints, imports from `.schem`/`.litematic`/`.nbt`, a blueprint library,
  creative builds by hand or by command, road and stair planning, optional WorldEdit.
- **Stay configurable.** Variants, saved profiles, armable behaviours, live toggles
  (`!config_set`) that change behaviour without a restart, fleets of bots in one process.
- **Keep a record.** A journal of deaths, items, actions and LLM token usage, with daily
  rollups and analysis scripts.

## Support status

✅ supported and tested · 🧪 works but partial or untested here · 🚧 proposed ([OpenSpec](openspec/changes/)) · ❌ not supported

### Servers

| | status | notes |
|---|---|---|
| NeoForge 1.21.1 | ✅ | tested daily on mc02; mod channels, registry sync and config tasks handled |
| Other NeoForge versions | 🧪 | set `MC_VERSION`; the handshake follows the 1.21.1 wire formats |
| Vanilla, Paper, Spigot | 🧪 | the NeoForge layer stays idle; not part of regular testing |
| Fabric / Quilt | 🧪 | fine when no mod needs a client side; not tested |
| Legacy Forge (FML 1.12 to 1.20.1) | ❌ | different handshake, not implemented |
| Offline auth | ✅ | what mc02 uses |
| Microsoft accounts | 🧪 | Mineflayer supports it (`MC_AUTH=microsoft`); not tested here |
| Modded items and mobs | ✅ | real names from NeoForge's registry sync |
| Modded blocks | 🧪 | treated as full cubes, since their states aren't synced |
| Mod GUIs, Create contraptions, Ars spells, Curios slots | ❌ | |
| Games other than Minecraft Java | 🚧 | the LLM brain, intents, behaviours and context packs are game-agnostic; a game-adapter split is proposed in [game-adapters](openspec/changes/game-adapters/proposal.md) |

### Bot features

| | status | notes |
|---|---|---|
| Chat commands (`!follow`, whispers) | ✅ | |
| Plain-language commands without an LLM | ✅ | [intents](docs/guide/intents.md); known misses: 🚧 [intent-parser-gaps](openspec/changes/intent-parser-gaps/proposal.md) |
| Local embedding layer (MiniLM) | ✅ | optional dependency, ~2.5 ms per message |
| Local LLM layer (Ollama, llama.cpp) | 🧪 | built and benchmarked, off by default: small models misfire |
| LLM brain (Claude / Codex subscription or API) | ✅ | goals, budgets, quota pause, token usage in the journal |
| NPC mode when the LLM quota runs out | ✅ | default routine: 🚧 [daily-routine](openspec/changes/daily-routine/proposal.md) |
| Reflexes and combat (weapons, shields, crits, creepers) | ✅ | |
| Bodyguard | ✅ | a third fewer hits in the [mob-wave benchmark](docs/guide/behaviors.md); 🚧 [guard-intercept](openspec/changes/guard-intercept/proposal.md), [bodyguard-coexistence](openspec/changes/bodyguard-coexistence/proposal.md), [guard-bench-modes](openspec/changes/guard-bench-modes/proposal.md) |
| Food, farming, woodcutting, mining, tool upgrades | ✅ | |
| Search and fetch (`find_target`, `bring_item`, `fetch_drops`) | 🧪 | ores and water found live; hunting, shearing and re-runs: 🚧 [search-gaps](openspec/changes/search-gaps/proposal.md) |
| Building from blueprints, imports (.schem, .litematic, .nbt) | ✅ | |
| Roads and stairs between buildings | ✅ | stair tower as an action: 🚧 [stair-tower-action](openspec/changes/stair-tower-action/proposal.md) |
| WorldEdit | 🧪 | needs WorldEdit permission for the bot |
| Live config, profiles, fleets, journal | ✅ | |
| Job queue ("farm, then wood, then home") | 🚧 | [job-queue](openspec/changes/job-queue/proposal.md) |
| Guarding an area or village | 🚧 | [area-guard](openspec/changes/area-guard/proposal.md) |
| Alerts for unknown players | 🚧 | [player-alerts](openspec/changes/player-alerts/proposal.md) |

## Quick start

```bash
asdf install            # node + just from .tool-versions
just setup              # npm ci, creates .env from .env.example
just run                # runs variants/buddy.ts
```

In game: `!help`.

```bash
just bots               # list bots
just actions buddy      # its commands / LLM tools
just run buddy --username Helper --owners Robin
just fleet fleet.yaml   # several bots in one process (see fleets/example.yaml)
```

## Writing a variant

```ts
// variants/guard.ts
import { defineVariant } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'

export default defineVariant({
  name: 'guard',
  username: 'Guardian',
  skills: standardSkills(),
  brains: [commandBrain(), reflexes()],
  onSpawn: (agent) => agent.act('guard', { player: 'Robin' }, { caller: { kind: 'system', name: 'boot' } })
})
```

The pieces:

- **Actions** are everything a bot can do (`follow`, `attack`, `collect`...), with zod
  parameter schemas. The same definition is a chat command, an LLM tool and a typed function.
- **Skills** group actions plus per-session setup and observations.
- **Brains** decide what to do: chat commands, reflexes, NPC loops, LLMs. Several run at once
  and share the body through action priorities (player > LLM > NPC, reflexes preempt and
  resume).
- **Variants** (`variants/*.ts`) pick skills, brains and default persona: what kind of bot.
- **Profiles** (`profiles/*.yaml`) are saved instances of a variant: username, owners, server,
  LLM model/login, reflexes, retries, humanize, journal, plus an optional context pack
  (`profiles/<name>/`: AGENTS.md, USER.md, MEMORY.md, skills, hooks).
- **Fleets** (`fleets/*.yaml`) run several profiles/variants in one process, across servers.

Core mechanisms every bot gets: long-distance travel, learned protected areas, hostile/flyer
aware combat with tunable reflexes, a journal of what happened, retries, rate-limited
(optionally humanized) chat, and per-component logging.

Details in [docs/concepts/architecture.md](docs/concepts/architecture.md) and
[docs/concepts/world.md](docs/concepts/world.md).

## Docs

The full docs live in [docs/](docs/) (guides, concepts, generated action reference). Browse
them as a local site with `just docs` (dev server) or `just docs-build` (static HTML).

Guides worth starting with:

- [Getting started](docs/guide/getting-started.md) and [writing a bot](docs/guide/writing-a-bot.md)
- [Plain-language commands and the intent layers](docs/guide/intents.md)
- [Behaviours](docs/guide/behaviors.md): keep_fed, stay_safe, follow_owner, bodyguard, NPC mode, the guard benchmark
- [Search and fetch](docs/guide/search.md): `find_target`, `bring_item`, `fetch_drops`
- [LLM brain](docs/guide/llm-brain.md): providers, listen modes, budgets, quota pause
- [Goals and building](docs/guide/goals-and-building.md), [blueprints](docs/guide/blueprints.md), [roads](docs/guide/roads.md), [WorldEdit](docs/guide/worldedit.md)
- [Tool progression](docs/guide/progression.md): tools, mining, what to do when digging gives nothing
- [Live config](docs/guide/live-config.md) and [profiles](docs/guide/profiles.md)
- [NPC brain](docs/guide/npc-brain.md), [self-improving NPCs](docs/guide/self-improver.md), [scenes](docs/guide/scenes.md)
- [Context packs](docs/guide/context-pack.md) and the [journal](docs/guide/journal.md)
- Concepts: [architecture](docs/concepts/architecture.md), [world, movement and combat](docs/concepts/world.md)
- Reference: [skills](docs/skills.md) and the generated [action reference](docs/reference/actions.md)

## buddy's commands

Say them in chat with `!`, or whisper without it. `!help <command>` explains one.
Positional args follow the parameter order, `key=value` works too (`!follow distance=4`).

`!come` `!follow [player] [distance]` `!goto <x> [y] <z>` `!goto_player <player>` `!stop`
`!guard [player]` `!attack` `!eat` `!sleep` `!wake` `!inventory` `!drop [item|all] [count]`
`!equip <item>` `!collect <block> [count]` `!pos` `!hp` `!say <text>` `!look_at` `!jump`

It also fights back when hit, eats when hungry, respawns and reconnects. Bots with the
intents brain understand the same requests in plain chat ("follow me", "come here"); say
"help" to the bot for the list.

## Config

Env vars, see [.env.example](.env.example): server (`MC_HOST`, `MC_PORT`, `MC_AUTH`),
`MC_OWNERS` (who may command bots), `MC_CAN_DIG`, `MC_LOG_LEVEL`. Per-bot values in the bot
definition or the fleet file override them.

## How it gets into a NeoForge server

Mineflayer only speaks vanilla. `src/core/neoforge/` adds:

1. **Channel negotiation.** NeoForge rejects clients that don't list every payload channel its
   mods require, with the right version and direction. The bot learns them from the server's
   rejection message over 3–4 quick reconnects and caches them in `data/`. Channels are offered
   as optional on both configuration and play, so NeoForge ignores the ones that don't apply.
2. **NeoForge config tasks.** Answers registry sync, config sync, data map negotiation,
   extensible enum and feature flag checks.
3. **Unparseable packets are dropped.** Item stacks with modded data components can't be
   parsed (components have no length prefix), which would kill the connection. Those packets
   (recipe list, command tree, some item packets) are skipped instead.
4. **Modded names.** The server's registry sync gives modded items and mobs their real names
   (`create:andesite_alloy`), and `ars_nouveau:wilden_*`-style patterns mark modded hostiles.
5. **Modded blocks are solid.** Unknown block states are treated as full cubes so bots don't
   fall through Create casings.

## Limitations

- Modded items and mobs have real names (from NeoForge's registry sync); modded blocks are
  all `modded_block` (full cubes), since their states aren't in the sync.
- Packets with modded items may be skipped, so inventories can be incomplete.
- No interaction with Create contraptions, Ars spells, Curios slots or mod GUIs yet.

## Development

```bash
just            # list recipes
just check      # typecheck + unit tests
just probe      # connect once, dump the world snapshot
just chat-test  # join as a second player and send commands to a running bot
```

TypeScript runs directly on Node 26 (type stripping), no build step; `tsc` only typechecks.
Specs live in `openspec/`.

## License

[GNU LGPL v3.0 or later](COPYING.LESSER) (which builds on the [GPL v3.0](COPYING)). The
blueprints in `blueprints/library/` come from other projects and keep their own licenses (MIT,
LGPL-3.0, CC0); see [blueprints/library/LICENSES.md](blueprints/library/LICENSES.md).
