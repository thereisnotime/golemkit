## Context

Brains share one body through `Agent.act()` and caller priorities. The NPC brain sits at `PRIORITY.npc` (20): above idle, below LLM (30), player (50), reflex (60). It must never fight those callers for the body, and it has to cope with actions that only some bots have (chores come from skills built separately).

## Decisions

### Utility AI over behaviour trees or FSMs
Each behaviour scores itself 0..100 from a shared blackboard; the brain runs the best one. Adding a behaviour is one object, and bots tune NPCs by changing numbers rather than rewiring a tree. Suggested bands: idle 5-15, social 15-25, chores 25-45, routine 40-70, needs 50-90, danger 70-100.

### Selection is a pure function
`decide(scores, running, now, opts)` in `select.ts` returns start / keep / switch / stop / idle. Rules:
- nothing running: start the best positive score
- the running behaviour dropped to 0: switch to the best or stop
- otherwise switch only if the challenger beats the running score by `switchMargin` (10), and the running behaviour has had `minRunMs` (3 s) or the challenger is urgent (>= 80)

Behaviours that finish naturally free the slot, so low scores still get turns at completion boundaries even when the margin prevents interrupting.

### Cooldowns
A behaviour can set `cooldownMs` after a success (follow_player loses interest for 90 s). Failures back off exponentially from `failureCooldownMs` (default 5 s, cap 120 s), so "no bed nearby" does not retry every tick.

### Backing off
Each tick first checks `agent.currentAction`. If a caller other than `brain:<name>` holds it at our priority or above, the brain aborts its running behaviour and pauses for a per-kind back-off (player/brain 20 s, reflex 3 s, system 10 s), extended every tick while the holder stays. The `act()` wrapper given to behaviours turns `busy: ...` results and foreign aborts (`preempted`, `replaced`, `stopped`, `died`) into an `NpcYield`, which triggers the same back-off. A player saying `!stop` therefore also makes the NPC wait before resuming.

Lower-priority holders (idle) are ignored: our next act preempts them.

### Interrupting our own action
When the brain switches behaviour, the old behaviour's signal is aborted, but its in-flight agent action has its own controller inside Agent. Rather than adding an abort API to Agent, the brain runs an internal no-op action `npc_interrupt` at the same priority, which replaces our action (equal priority replaces). No core change needed.

### Long-running actions
Behaviours should prefer bounded actions (wander walks once, follow_player uses `goto_player` in a loop rather than `follow`). If an NPC-run long action is preempted and later resumed by Agent, it resumes under caller `brain:npc`, which the brain treats as its own; the next decision replaces it.

### Blackboard
Refreshed every tick from the bot (tolerant of a half-loaded bot): needs `hunger`, `health`, `danger`, `inventoryFull`, `tiredness`, custom needs set by hooks; facts `timeOfDay`, `isNight` (bed window 12542..23459 or thunder), `sleeping`, `home`, `homeDistance`, `nearestHostile` (ignoring neutral mobs like endermen), `nearestPlayer`. `recall/persist` store values under `npc.<key>` in `agent.storage`. Home and places are stored by the navigation skill under `home` / `places`.

### Hooks
`hooks` run every tick before scoring and don't need the body. Used for custom needs and for cheap side effects like greetings (rate limited per player and globally, plus a random roll).

### Graceful degradation
`Behavior.requires` lists actions; a behaviour scores 0 when any is missing. `actionBehavior()` sets it automatically, so `bots/villager.ts` can list `chop_tree`, `harvest`, `deposit` without importing those skills.

### Status
`npc_status` (non-exclusive) returns a one-line summary for chat and a full JSON object (current behaviour, top scores, cooldowns, last outcomes, needs, back-off).

## Risks / Trade-offs

- Tick-based (1.5 s): reactions to danger lag by up to a tick; reflexes cover the urgent case (being hit).
- Scores are hand-tuned numbers; bots mixing many behaviours need to think about the bands.
- The brain registers actions on the agent from `start()`, so `cli.ts actions <bot>` (which never starts the agent) doesn't list `npc_status`.
