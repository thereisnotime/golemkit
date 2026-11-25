# Status view

## Why

The owner only finds out a bot is stuck by asking it in chat or reading debug logs (the NPC
controller's idle report every 2 minutes). "Is it working, and if not, why" should be visible at
a glance from a terminal and in game, and a stuck bot should say so on its own.

## What changes

- Every agent keeps a status snapshot (`agent.status`, `src/core/statusTracker.ts`): the action
  holding the body (caller, priority, time), each NPC controller's running behaviour and score or
  why nothing runs, time since the last progress, health, food, position, the last failure, and
  the need and goal when a decision loop reports them.
- `NpcController.snapshot()`: a read-only plain object (`DeciderSnapshot`) the status reads;
  optional `need`, `goal`, `reason`, `lastProgressAt` for richer loops.
- `data/bots/<username>/status.json`, rewritten every `status.intervalMs` (5 s); `node src/cli.ts
  status [name]` / `just status` prints it, or one line per bot.
- A game-agnostic `status` action on every agent (`!status`, aliases `why`, `stuck`; the `hp`
  action loses its `status` alias) and intents phrasings ("why are you idle", "are you stuck").
- The stuck alert: no progress for `status.stuckAlertMs` (10 min) while it wants to do something
  whispers the online owners once, then with doubling back-off up to `status.alertMaxMs` (2 h).
- Profile key `status:` (lands in `settings.status`) and `status.*` feature toggles.

## Status

Implemented, unit tested; no live run recorded yet.
