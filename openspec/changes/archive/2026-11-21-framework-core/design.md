## Decisions

- **Actions are the single extension point.** One zod-typed definition serves chat commands (positional/key=value parsing), LLM tools (`z.toJSONSchema`) and typed calls from code.
- **Action lock with priorities** (idle < npc < llm < player < reflex < system). Higher preempts; preempted long-running actions are suspended and resumed, so reflexes don't break follow/guard. Lower priority is rejected rather than queued, so brains re-plan instead of piling up stale work.
- **Agent outlives connections.** Skills/brains get per-session hooks; storage and brain state persist across reconnects.
- **Pathfinder lives in core**: nearly every skill needs it, and Movements depend on per-bot settings (canDig).
- **Fleet in one process** shares the tolerant parser patch and registry data; logins are staggered.
- **No build step.** Erasable TS syntax only.
