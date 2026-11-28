## Why
After moving machines Pax reconnected and the status showed health 0 with nothing logged. mineflayer asks to respawn only once, on its death event, and only while its isAlive flag says so; a bot that logs in dead or whose one request got lost stays on the death screen with nothing running.

## What Changes
- A respawn watcher in the Minecraft adapter reads health from login on and asks to respawn while dead, every `respawn.retrySeconds`, reconnecting after `respawn.maxTries` asks.
- Log lines: `dead at login (health 0), respawning`, `dead (health 0), respawning (try n)`, `respawned (health 20)`.
- The decision is a pure planner in `src/core/respawnPlan.ts` with unit tests; new profile key `respawn` and live toggles.
