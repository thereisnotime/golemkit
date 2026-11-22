## Why

golemkit bots only act when a player commands them (command brain) or when something hits them (reflexes). An NPC should live on its own: wander near home, go back at night, sleep, eat, deal with mobs, notice players, and pick up chores when the bot has the skills for them. That decision loop should be a reusable framework piece that bots configure, not one hard-coded bot.

## What Changes

- New NPC brain (`src/brains/npc/`): a utility-AI loop. Behaviours have `score(ctx)` and `run(ctx)`; the highest score wins with hysteresis (switch margin, minimum run time, urgent override). It acts only through `agent.act()` at `PRIORITY.npc` and backs off when a player, LLM, reflex or system caller holds the body.
- Blackboard with needs (hunger, health, danger, inventory fullness, tiredness, custom) and facts (time of day, night, home distance, nearest hostile/player), plus persisted memory in `agent.storage`.
- Behaviour library: wander, go_home, sleep_at_night, eat, danger (flee or fight), follow_player, a greetPlayers hook, and `actionBehavior(action, params, score)` to turn any action into a behaviour that switches off when the action is missing.
- Navigation skill (`src/skills/navigation.ts`): `wander`, `set_home`, `go_home`, `remember_place`, `forget_place`, `places`, `goto_place`, `flee`. Home and places persist in storage.
- `npc_status` action for debugging; debug logs on behaviour switches.
- Example bot `bots/villager.ts`.
- Docs: `docs/guide/npc-brain.md`.

## Impact

- No core changes. The brain registers two actions (`npc_status`, internal `npc_interrupt`) on the agent in `start()`.
- Additive exports in `src/brains/index.ts` and `src/skills/index.ts`.
