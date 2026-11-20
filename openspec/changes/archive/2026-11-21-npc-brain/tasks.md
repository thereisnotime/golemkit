## 1. Navigation skill

- [x] 1.1 `wander`, `set_home`, `go_home`, `remember_place`, `forget_place`, `places`, `goto_place`, `flee` in `src/skills/navigation.ts`
- [x] 1.2 Home and places persisted in agent.storage; observe() reports home distance

## 2. NPC brain

- [x] 2.1 Pure selection (`select.ts`): best, decide with margin / minRunMs / urgent, failure back-off
- [x] 2.2 Blackboard: needs, facts, custom needs, persisted memory
- [x] 2.3 Controller: tick loop, hooks, back-off for foreign callers, act wrapper with NpcYield, self-interrupt via `npc_interrupt`, cooldowns, status
- [x] 2.4 `npcBrain()` brain definition, `npc_status` action, auto home on first spawn

## 3. Behaviours

- [x] 3.1 wander, go_home, sleep_at_night, eat, danger (flee or fight), follow_player
- [x] 3.2 greetPlayers hook
- [x] 3.3 `actionBehavior()` helper

## 4. Bot, docs, tests

- [x] 4.1 `bots/villager.ts`
- [x] 4.2 `docs/guide/npc-brain.md`
- [x] 4.3 Unit tests for selection, hysteresis, back-off, cooldowns, degradation
- [x] 4.4 Live run on mc02 as NpcTest
