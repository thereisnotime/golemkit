# Tasks

Every phase ends with the parity checks below; a phase is done only when they all pass.

## Phase 0: safety net (no code moves)

- [ ] Baseline: test count, `tsc`, docs build, `just scope-check` counts, recorded in `openspec/changes/game-adapters/baseline.md`
- [ ] Golden snapshots as test fixtures: `observe()` output for fixed fake worlds, the action catalog and LLM tool schemas, intent decisions for the seen and held-out phrase sets
- [ ] Packet replay harness: record a real session (login, NeoForge handshake, a few minutes of play) and replay it offline through the client; assert the same handshake and events
- [ ] Benchmark baselines saved in the repo: `just intents-bench`, `just guard-bench` (mixed and ranged waves, 3 runs each)
- [ ] Live smoke script: connect, follow, chop, find iron, bring planks, go home; results recorded

## Phase 1: the line (no behaviour change)

- [x] `GameAdapter` interface: connect and reconnect, identity, chat, observation, events, capabilities
- [x] `ServerPlatform` interface inside the Minecraft adapter: vanilla, Paper, NeoForge (later Fabric)
- [x] Lint rule: no `mineflayer` / `prismarine-*` imports or `agent.bot` outside adapters (warning first; the violations are the work list)

## Phase 2: Minecraft behind the interface

- [x] Move the Mineflayer agent into `src/adapters/minecraft-java`
- [x] Move the NeoForge layer into `src/adapters/minecraft-java/platforms/neoforge`; vanilla and Paper as thin platforms
- [x] `src/core/index.ts` keeps re-exporting so variants, profiles and scripts don't change
- [x] Replace direct `agent.bot` use in brains (behaviour library, npc, self) with adapter calls

## Phase 3: capabilities

- [x] Actions and behaviours declare the capabilities they need; agents only offer what the adapter supports (LLM tools and "help" follow)
- [x] Lint rule becomes an error

## Phase 4: a second game

- [ ] A second adapter (Minecraft Bedrock via `bedrock-protocol`, or Luanti) with chat, move, follow, observe
- [ ] Adapter contract tests every adapter must pass
- [ ] Adapter author guide in the docs

## Parity checks (after every phase)

| check | must be |
|---|---|
| unit tests and tsc | all pass, same count or more |
| golden snapshots | identical |
| packet replay | same handshake and events |
| intents bench | identical (deterministic) |
| guard bench | within run-to-run variance (3 runs) |
| live smoke script | same results |
| Pax | runs for hours with no new errors |
