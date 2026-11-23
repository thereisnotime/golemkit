# golemkit

Framework for game bots with a game-agnostic core; each game sits behind an adapter interface. The one adapter today is Minecraft Java on Mineflayer, tested on NeoForge (vanilla and Paper work too, picked with `MC_PLATFORM`). TypeScript run directly by Node (see `.tool-versions`), no build step. Read `docs/concepts/architecture.md` before changing core, skills or brains.

## Layout

- `src/core/` agent lifecycle, action lock and priorities, chat queue, storage, CLI helpers, and `adapter.ts` (the GameAdapter interface and capabilities). `src/core/index.ts` is the public API; skills, brains and bots import from there (it also re-exports the Minecraft helpers).
- `src/adapters/minecraft-java/` the Minecraft Java adapter: Mineflayer, pathfinder and session events (`adapter.ts`), helpers, journal capture, reflexes, the behaviour library, stock NPC behaviours, scene actions, and the server platforms in `platforms/` (`neoforge/` with wire formats from neoforged/NeoForge branch `1.21.1`, `network/payload/`; `vanilla`, `paper`).
- `src/skills/` Minecraft actions grouped by topic, with the pure planners next to them (`foodPlan`, `farmPlan`, `searchPlan`, `reachPlan`, `ranged-plan`, `techniques`, `pvp`, ...). `src/brains/` decision loops. `variants/` bot definitions. `scripts/` live-server tools.

## Scope: game-agnostic vs game-specific

The [game-adapters change](openspec/changes/game-adapters/proposal.md) splits the code into a game-agnostic core and game adapters; phases 0 to 3 are done (Minecraft Java behind the interface, capability gating), phase 4 (a second game) is open. [docs/concepts/adapters.md](docs/concepts/adapters.md) describes the interfaces; [docs/concepts/scope.md](docs/concepts/scope.md) has the per-directory table with counts (`node scripts/scope-check.ts`).

- Game-agnostic: `src/core/`, `src/llm/`, `src/context/`, `src/cli.ts`, and the brain frameworks in `src/brains/` (command, hooks, llm, intents pipeline, npc controller, behaviours framework, scene director, self-improver).
- Minecraft-specific: `src/adapters/minecraft-java/`, `src/skills/` (except `config`, and the journal actions), `variants/`, `blueprints/`. NeoForge-specific: `src/adapters/minecraft-java/platforms/neoforge/`.
- Mixed: `profiles/` (generic keys, Minecraft values), `scripts/` (live tests per adapter), the intents pattern table.

Game-agnostic code must not import `mineflayer`, `prismarine-*`, `minecraft-*` or `vec3`, and must not touch `agent.bot`; it goes through `agent.act()`, agent events and `agent.adapter` (self, entities, inventory, time, players, events). `just check` runs `scripts/adapter-lint.ts`, which fails on a violation. Minecraft-specific code goes in a skill or in the adapter; actions, skills and behaviours declare the `capabilities` they need (`dig`, `place`, `move`, ...) so agents on a game without them don't offer them. Docs pages carry `scope: core | minecraft | neoforge | mixed` in their frontmatter (`scopeNote` for mixed); set it on new pages.

## Rules

- Node type stripping: only erasable TS syntax. No `enum`, `namespace`, parameter properties or decorators. Relative imports use the `.ts` extension; type-only imports use `import type`.
- Every capability is an action with a zod schema and a clear `description` (it's shown to players and LLMs). Long actions must honour `ctx.signal`; use `goto`, `holdGoal`, `sleep`, `checkAborted` from core.
- Brains act through `agent.act()` with a caller and priority, never by driving the pathfinder directly, so the action lock stays authoritative.
- Chat goes through `agent.say/whisper/reply` (rate limited), never `bot.chat` directly.
- When changing the handshake, check the payload id and codec in the NeoForge source; don't guess channel names.
- Don't add mineflayer plugins that depend on an old mineflayer (mineflayer-pvp does).
- `just check` (tsc + unit tests + adapter-lint) before committing; `just parity` adds the golden snapshots, packet replay and intents bench comparison. `just probe` / `just chat-test` hit the real server; keep them out of `npm test`.
- Update `openspec/` when behaviour changes.
