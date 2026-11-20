## Context

All bots of a fleet live in one process. Bots on the same server share a message bus and a blackboard (`src/core/fleet.ts`). Bodies are arbitrated by `agent.act()` with priorities.

## Decisions

### Director-driven timeline
The director holds the whole beat tree and runs it; cast members are thin executors. For every beat the director sends `scene:do` to the member and waits for `scene:done`. This keeps pause, recast and interaction handling in one place: when a role is recast, the next beat simply goes to the new username. `cue`/`await` are sync points inside the director and are also broadcast as `scene:cue` on the fleet bus so other brains (and other scenes) can react or trigger awaits.

### Casting and election
Each scene-brain bot registers itself in the blackboard key `scene:actors` (online flag, `director` flag, the run it is busy in). Any bot receiving `scene_start` forwards it to the coordinator (an online `director: true` bot, else the lowest username). The coordinator casts: roles are filled in declaration order by preferred bots first, then by the remaining eligible bots sorted by name (eligible = online, not busy, has the role's required actions). The director of the run is a `director: true` bot if one is online, else the lowest username in the cast. Deterministic, so the same inputs always give the same cast.

### Recasting
The director watches `scene:actors`. If a cast member goes offline it pauses the run, cancels in-flight beats and looks for a replacement (the same bot reconnecting, or another eligible actor) for up to `recastTimeoutMs`. Found: resume, retrying the interrupted beats. Not found: abort cleanly.

### Priority
A new `PRIORITY.scene = 25`. An NPC routine (20) is suspended while a scene uses the bot and resumes afterwards; LLM (30), player (50) and reflex (60) callers still win. When a beat finds the body held by a higher-priority caller it waits up to `busyWaitMs` and then skips that beat. Chat lines and non-exclusive beats still run.

### Holding the body between beats
A cast member that is between beats runs the internal long-running `scene_hold` action at scene priority. Without it the body is free during waits and other roles' lines, and an NPC brain (priority 20) would start wandering or chatting mid-scene. Each beat replaces the hold at equal priority; a player command suspends and later resumes it; stopping the run cancels it with the rest.

### Stopping only our actions
Scene actions use the caller `{ kind: 'brain', name: 'scene:<runId>' }`. `Agent.cancelActions(match)` aborts the current action and drops suspended ones that match, leaving everything else (including suspended NPC routines) alone. Previously only `stopActions()` existed, which clears every suspended action.

### Chat pacing
The director paces lines across the whole cast (default 1.6 s between any two lines, 2 s per bot) on top of the agent's own chat queue, plus a typing delay proportional to line length.

### Player interactions
Members watch for players (non-fleet) coming within range, chatting nearby or naming a cast member, and hitting them, and forward `scene:player` events to the director. The director dedupes, applies cooldowns (per interaction, per player, max per run) and runs the reaction: `pause` mode pauses the timeline, cancels in-flight beats, runs the reaction beats and resumes (interrupted beats are retried); `aside` runs alongside.

### Format
Beats are single-key objects (`say:`, `act:`, ...) with a few shared fields (`as`, `timeoutMs`, `optional`). Top-level fields go through zod; beats are parsed recursively by kind with per-kind zod schemas, so errors carry a path (`beats[3].parallel[1][0]: unknown role "minr"`). References (roles, marks, cues) are checked after parsing.

## Trade-offs

- The director relies on every scene bot being in the same process (true for fleets). Messages are still used for commands and cues so the protocol stays explicit.
- Anchor and approach checks read peers' positions directly through the fleet for simplicity.
- Retrying an interrupted movement beat may repeat a short walk; acceptable for scenes.
