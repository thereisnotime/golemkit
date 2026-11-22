# golemkit

Framework for Minecraft bots on NeoForge servers, built on Mineflayer. TypeScript run directly by Node (see `.tool-versions`), no build step. Read `docs/concepts/architecture.md` before changing core, skills or brains.

## Layout

- `src/core/` agent lifecycle, action lock and priorities, chat queue, storage, CLI helpers. `src/core/index.ts` is the public API; skills, brains and bots import from there.
- `src/core/neoforge/` the NeoForge layer (wire formats from neoforged/NeoForge branch `1.21.1`, `network/payload/`).
- `src/skills/` actions grouped by topic. `src/brains/` decision loops. `variants/` bot definitions. `scripts/` live-server tools.

## Scope: game-agnostic vs game-specific

The [game-adapters proposal](openspec/changes/game-adapters/proposal.md) splits the code into a game-agnostic core and game adapters (Minecraft Java first). [docs/concepts/scope.md](docs/concepts/scope.md) has the per-directory table with counts; `node scripts/scope-check.ts` prints them.

- Game-agnostic: `src/llm/`, `src/context/`, `src/cli.ts`, and in `src/core/` the events, fleets, log, profile, retry, storage and toggles modules.
- Mixed (generic framework, Minecraft parts): `src/core/agent.ts`, `helpers.ts`, `humanize.ts`, `protection.ts`, `modded.ts`, `action.ts`, `brain.ts`, `skill.ts`, `definition.ts` (Mineflayer types only), `src/core/journal/capture.ts`, `src/brains/*` (the frameworks are generic; reflexes, the behaviour library and stock NPC behaviours are Minecraft), `profiles/`, `scripts/`.
- Minecraft-specific: `src/skills/` (except `config`, and the journal actions), `variants/`, `blueprints/`.
- NeoForge-specific: `src/core/neoforge/`.

New game-agnostic code must not import `mineflayer`, `prismarine-*`, `minecraft-*` or `vec3`, and must not touch `agent.bot`; it goes through `agent.act()` and agent events. Minecraft-specific code goes in a skill or, for the server handshake, in the NeoForge layer. Docs pages carry `scope: core | minecraft | neoforge | mixed` in their frontmatter (`scopeNote` for mixed); set it on new pages.

## Rules

- Node type stripping: only erasable TS syntax. No `enum`, `namespace`, parameter properties or decorators. Relative imports use the `.ts` extension; type-only imports use `import type`.
- Every capability is an action with a zod schema and a clear `description` (it's shown to players and LLMs). Long actions must honour `ctx.signal`; use `goto`, `holdGoal`, `sleep`, `checkAborted` from core.
- Brains act through `agent.act()` with a caller and priority, never by driving the pathfinder directly, so the action lock stays authoritative.
- Chat goes through `agent.say/whisper/reply` (rate limited), never `bot.chat` directly.
- When changing the handshake, check the payload id and codec in the NeoForge source; don't guess channel names.
- Don't add mineflayer plugins that depend on an old mineflayer (mineflayer-pvp does).
- `just check` (tsc + unit tests) before committing. `just probe` / `just chat-test` hit the real server; keep them out of `npm test`.
- Update `openspec/` when behaviour changes.
