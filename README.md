# mc-buddy

A TypeScript framework for Minecraft bots on **NeoForge** servers: player assistants,
self-sufficient NPCs, LLM-driven agents. Bots are real protocol clients built on
[Mineflayer](https://github.com/PrismarineJS/mineflayer), not headless Minecraft, so they
start in a second and use ~100 MB each.

Built for the **mc02** NeoForge 1.21.1 modpack (Create, Ars Nouveau, Curios, ...), but the
NeoForge layer learns any server's mod channels on its own.

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
just run buddy --username Helper --owners robin
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
  onSpawn: (agent) => agent.act('guard', { player: 'robin' }, { caller: { kind: 'system', name: 'boot' } })
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

Change settings in game without a restart (`!config_set`): [docs/guide/live-config.md](docs/guide/live-config.md).
Profiles (instances, LLM listen modes, immersive mode, humanize, retries, proxy): [docs/guide/profiles.md](docs/guide/profiles.md).
Movement, protected areas, combat and reflexes: [docs/concepts/world.md](docs/concepts/world.md).
Self-sufficient NPCs (utility-AI brain, behaviours, `variants/villager.ts`): [docs/guide/npc-brain.md](docs/guide/npc-brain.md).
LLM-driven bots on your Claude / Codex subscription or an API (`variants/companion.ts`): [docs/guide/llm-brain.md](docs/guide/llm-brain.md).
Armable behaviours (keep_fed, stay_safe, follow_owner, guard_area...) that owners and LLMs switch on and that run between turns: [docs/guide/behaviors.md](docs/guide/behaviors.md).
Goals that LLM bots work through on their own, and building structures from YAML blueprints: [docs/guide/goals-and-building.md](docs/guide/goals-and-building.md).
NPCs that run their own program and rewrite it with one LLM call when an owner teaches them (`variants/apprentice.ts`): [docs/guide/self-improver.md](docs/guide/self-improver.md).
Per-profile rules, skills, memory and hooks, with an A/B eval: [docs/guide/context-pack.md](docs/guide/context-pack.md).
What happened to each bot (deaths, items, actions, daily rollups, `!last_death`): [docs/guide/journal.md](docs/guide/journal.md).

What each skill and action does, including `extendedSkills()` (crafting, chests, farming, woodcutting, building): [docs/skills.md](docs/skills.md).
Scenes with several bots acting together (`variants/actor.ts`, `scenes/*.yaml`): [docs/guide/scenes.md](docs/guide/scenes.md).

## buddy's commands

Say them in chat with `!`, or whisper without it. `!help <command>` explains one.
Positional args follow the parameter order, `key=value` works too (`!follow distance=4`).

`!come` `!follow [player] [distance]` `!goto <x> [y] <z>` `!goto_player <player>` `!stop`
`!guard [player]` `!attack` `!eat` `!sleep` `!wake` `!inventory` `!drop [item|all] [count]`
`!equip <item>` `!collect <block> [count]` `!pos` `!hp` `!say <text>` `!look_at` `!jump`

It also fights back when hit, eats when hungry, respawns and reconnects.

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
