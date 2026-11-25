# Design

## Where it lives

Pure logic in `src/core/status.ts` (options, `assess`, `idleReason`, `alertDue`, `alertText`,
`chatLine`, `formatStatus`), unit tested. `src/core/statusTracker.ts` wires it: one tracker per
agent, started in `Agent.start()`, stopped in `Agent.stop()`. Game-agnostic: it reads
`agent.adapter.self/inventory/players`, the agent's `actionStart`, `actionEnd`, `session` and
`sessionEnd` events, and decision-loop sources. No `agent.bot`, no game library.

Decision loops register a source (`agent.status.addSource(name, () => controller.snapshot())`)
in the brain's session hook (npc, behaviors, self), so the controller itself only gained the
read-only `snapshot()` accessor; the goals-idle work can extend `DeciderSnapshot` with need, goal,
reason and its own progress time without touching the tracker.

## Reading it from another process

A file the bot rewrites (write to `.tmp`, rename) is the simplest thing that works across
processes, needs no port and no auth, and survives the bot for a post-mortem. The CLI marks it
stale after 3 intervals (at least 15 s). A socket or HTTP endpoint was not added: the codebase has
no such pattern.

## Progress

Progress is any of: an exclusive, non-internal action that ended ok; a behaviour run that
succeeded (from the controller snapshot); more items in the inventory than at the previous
sample; being 16+ blocks from where it last made progress (net displacement, so pacing on the spot
does not count); a loop's own `lastProgressAt`; `noteProgress()` from code.

## Stuck

Stuck needs both "quiet" (no progress for `stuckAlertMs` since the later of the last progress and
the session start) and "wants something": an action holds the body, a behaviour runs, a behaviour
is cooling down after failures, a need or goal is set, or a failure happened since the last
progress. A long-running action (follow, guard) is `busy`, never stuck. A bot with nothing to do
is `idle`, never alerted.

## Trade-offs

- A behaviour that returns ok without doing anything counts as progress; failing behaviours are
  the usual stuck case and are caught.
- The alert goes to online owners only, like askHelp's `tell: owners`; with nobody online it is
  not counted as sent.
