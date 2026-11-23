<p align="center">
  <img src="docs/public/golem.svg" alt="golemkit" width="160">
</p>

<h1 align="center">golemkit</h1>

<p align="center">
  <b>Minecraft bots that pull their weight.</b><br>
  A TypeScript framework for companions, bodyguards, NPCs and LLM agents,<br>
  built on Mineflayer with first-class NeoForge support. Useful with or without an LLM.
</p>

<p align="center">
  <a href="https://github.com/thereisnotime/golemkit/blob/main/LICENSE"><img alt="License: LGPL-3.0" src="https://img.shields.io/badge/license-LGPL--3.0-blue"></a>
  <a href="https://thereisnotime.github.io/golemkit/"><img alt="Docs" src="https://img.shields.io/badge/docs-online-14b8a6"></a>
  <a href="https://github.com/thereisnotime/golemkit/actions/workflows/docs.yml"><img alt="Docs build" src="https://github.com/thereisnotime/golemkit/actions/workflows/docs.yml/badge.svg"></a>
  <img alt="Node 26" src="https://img.shields.io/badge/node-26-339933?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="Minecraft Java 1.21.1" src="https://img.shields.io/badge/Minecraft%20Java-1.21.1-62b47a">
  <img alt="NeoForge" src="https://img.shields.io/badge/NeoForge-supported-f26522">
  <a href="https://github.com/PrismarineJS/mineflayer"><img alt="Mineflayer" src="https://img.shields.io/badge/built%20on-Mineflayer-6b7280"></a>
</p>

<p align="center">
  <a href="https://thereisnotime.github.io/golemkit/">Documentation</a> ·
  <a href="https://thereisnotime.github.io/golemkit/guide/getting-started">Getting started</a> ·
  <a href="https://thereisnotime.github.io/golemkit/guide/intents">Talking to bots</a> ·
  <a href="https://thereisnotime.github.io/golemkit/roadmap">Roadmap</a>
</p>

---

Bots are real protocol clients, not headless Minecraft, so they start in a second and use about
100 MB each. golemkit is built and tested on a NeoForge 1.21.1 modpack (Create, Ars Nouveau,
Curios, ...); the NeoForge platform learns any server's mod channels on its own and stays idle on
vanilla and Paper servers (`MC_PLATFORM=vanilla` or `paper` skips it). The game itself sits
behind an adapter interface, so the core, brains and intents don't depend on Minecraft. See the
[support status](#support-status) for what has been tested.

## What the bots can do

- **Talk to them in plain chat.** "pax follow me", "guard me", "find iron", "bring me 16
  planks", "chop some wood". A layered intent pipeline (patterns, a local MiniLM embedding
  model, an optional local LLM, then the cloud LLM) handles it, and each layer can be switched,
  reordered, tuned live and benchmarked. Works with no LLM at all.
- **Run on an LLM when you want one.** Claude or Codex on your subscription, or an API. Goals
  they work through on their own, budgets, quota pauses, and an NPC fallback mode when the
  quota runs out.
- **Look after themselves and you.** Reflexes (fight back, eat, escape), adaptive weapons,
  shields, crits and skilled-player techniques (W-tap, sweeps, shield timing, totems, golden
  apples, water bucket clutch), cover and return fire against archers, remembered danger zones,
  a bodyguard behaviour that protects its owner, tool upgrades, a food ladder that searches
  wider, travels to known farms and grows its own, climbing out of caves, swimming up when low
  on air.
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
| Vanilla, Paper, Spigot | 🧪 | the NeoForge layer stays idle, or `MC_PLATFORM=vanilla` / `paper` skips it; not part of regular testing |
| Fabric / Quilt | 🧪 | fine when no mod needs a client side; not tested |
| Legacy Forge (FML 1.12 to 1.20.1) | ❌ | different handshake, not implemented |
| Offline auth | ✅ | what mc02 uses |
| Microsoft accounts | 🧪 | Mineflayer supports it (`MC_AUTH=microsoft`); not tested here |
| Modded items and mobs | ✅ | real names from NeoForge's registry sync |
| Modded blocks | 🧪 | treated as full cubes, since their states aren't synced |
| Mod GUIs, Create contraptions, Ars spells, Curios slots | ❌ | |
| Games other than Minecraft Java | 🚧 | Minecraft Java runs behind the [GameAdapter interface](docs/concepts/adapters.md) with capability gating ([game-adapters](openspec/changes/game-adapters/proposal.md) phases 0 to 3); a second game is phase 4 |

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
| Combat techniques (W-tap, sweeps, shield timing, totem, golden apples, water bucket, enderman gaze, chokepoints) | ✅ | `combat.*` toggles, benchmarked in [behaviours](docs/guide/behaviors.md); notes in [combat research](docs/concepts/combat-research.md) |
| Fighting back against players (`combat.pvp defend`) | 🧪 | off by default; never owners or `combat.friends` |
| Ranged defence (cover, shooting back) and danger zones | ✅ | `ranged_defense` reflex and stay_safe; spots where archers or a patrol were seen are avoided for a few minutes |
| Bodyguard | ✅ | intercepts mobs and pulls aggro off its player; a third fewer hits in the [mob-wave benchmark](docs/guide/behaviors.md); 🚧 [bodyguard-coexistence](openspec/changes/bodyguard-coexistence/proposal.md), [guard-bench-modes](openspec/changes/guard-bench-modes/proposal.md) |
| Food ladder (search rings, trips to known food places, seeds, a farm that grows to 9x9) | ✅ | `keep_fed` in [behaviours](docs/guide/behaviors.md) |
| Farming, woodcutting, mining, tool upgrades | ✅ | |
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
git clone https://github.com/thereisnotime/golemkit.git && cd golemkit
asdf install            # node + just from .tool-versions
just setup              # npm ci, creates .env from .env.example
$EDITOR .env            # MC_HOST, MC_OWNER, ...
just run                # runs variants/buddy.ts
```

In game: say `help` to the bot, or `!help` for the exact commands.

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
- Concepts: [architecture](docs/concepts/architecture.md), [world, movement and combat](docs/concepts/world.md), [combat research](docs/concepts/combat-research.md)
- [What is game-specific](docs/concepts/scope.md): which code is game-agnostic, Minecraft-specific or NeoForge-specific, and the [game adapters](docs/concepts/adapters.md) that keep them apart
- Reference: [skills](docs/skills.md) and the generated [action reference](docs/reference/actions.md)

## buddy's commands

Say them in chat with `!`, or whisper without it. `!help <command>` explains one.
Positional args follow the parameter order, `key=value` works too (`!follow distance=4`).

`!come` `!follow [player] [distance]` `!goto <x> [y] <z>` `!goto_player <player>` `!stop`
`!guard [player]` `!protect [player]` `!attack` `!hunt [animal] [count]` `!gear_up` `!eat`
`!sleep` `!wake` `!pillar` `!climb_out` `!bunker` `!inventory` `!drop [item|all] [count]`
`!equip <item>` `!collect <block> [count]` `!feed_player [player]` `!last_death` `!goto_death`
`!pos` `!hp` `!say <text>` `!look_at [player]` `!jump` `!config_set <key> <value>`

It also fights back when hit, eats when hungry, respawns and reconnects. Bots with the
intents brain understand the same requests in plain chat ("follow me", "come here"); say
"help" to the bot for the list.

## Config

Env vars, see [.env.example](.env.example): server (`MC_HOST`, `MC_PORT`, `MC_AUTH`,
`MC_PLATFORM`), `MC_OWNERS` (who may command bots), `MC_CAN_DIG`, `MC_LOG_LEVEL`. Per-bot values
in the bot definition, profile or fleet file override them; profiles can use `${VAR:-default}`
to read env vars. Full list in the [configuration reference](docs/reference/config.md).

## How it gets into a NeoForge server

Mineflayer only speaks vanilla. `src/adapters/minecraft-java/platforms/neoforge/` adds:

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

## Development

```bash
just            # list recipes
just check      # typecheck + unit tests + adapter lint
just parity     # offline parity: tests, golden snapshots, packet replay, intents bench
just probe      # connect once, dump the world snapshot
just chat-test  # join as a second player and send commands to a running bot
```

TypeScript runs directly on Node 26 (type stripping), no build step; `tsc` only typechecks.
Specs live in `openspec/`.

## Contributing

Issues and pull requests are welcome. Run `just check` (typecheck, unit tests, adapter lint) before sending
a change, and describe behaviour changes in [`openspec/`](openspec/): planned work lives in
[`openspec/changes/`](openspec/changes/) and on the [roadmap](https://thereisnotime.github.io/golemkit/roadmap).
Agent and coding conventions are in [AGENTS.md](AGENTS.md).

## License

[GNU LGPL v3.0 or later](LICENSE) (which builds on the [GPL v3.0](COPYING)). The
blueprints in `blueprints/library/` come from other projects and keep their own licenses (MIT,
LGPL-3.0, CC0); see [blueprints/library/LICENSES.md](blueprints/library/LICENSES.md).
