# Design

## Goals

`GoalStore` keeps one active goal per bot under `llm.goal` (plus the last 10 finished ones).
A goal has a text, the owner (turn player) and channel, ordered steps with done flags, notes,
and counters for the guardrails: autonomous turns since the owner last spoke, a deadline,
failure signatures, and stalls (turns without progress). Set/complete/abandon flush storage
at once so a crash can't resurrect a finished goal.

The goal tools are built-ins added through a new `BotTools.define()` hook, so `tools.ts` only
gained one public method. The runtime renders `GoalStore.fmtPrompt()` as `## Your active goal`
right after the trigger, and the brain's observe field carries a compact form.

## Continuation

A new trigger kind `goal` with reasons `continue`, `actionDone`, `idle`, `resume`, `stop`.
The runtime asks for a continuation (`scheduleGoal`, one pending timer, earliest wins) when:

- an action the brain started ends and wasn't interrupted (replaces the plain `actionDone`
  report while a goal is active, so there's one turn, not two);
- a turn ends with nothing holding the body: soon if it made progress (an ok non-chat tool
  call or a plan update), otherwise after the idle backoff;
- the bot reconnects (`onSession`, from the brain's session hook);
- a 5 s idle check finds nothing has happened for `idleDelay(stalls)` (20 s doubling to 5 min).

`continuationDecision()` is pure: wait while thinking, acting, disconnected, budget-blocked or
inside the reserved share of the hourly budget; stop when the turn limit or deadline is hit or
one failure signature reached `maxSameFailures`. A stop pauses the goal and runs one `stop`
turn in which the model tells the owner where things stand and asks. Owner chat renews the
limits and clears the pause. A player's `stop` action abandons the goal; `!goal_cancel`
abandons it and cancels the brain's actions.

## Building

Blueprint YAML: `roles` (default block, `accept` regex, kind block/door/attachment, optional,
material), a one-character `palette` (`air` = must be clear, `skip`, `" "` = don't care), and
`layers` bottom-up with rows north to south. `blueprint.ts` holds the pure parts: parsing,
rotation to a facing, world placement centred on an origin, role resolution (the `material`
parameter, else the accepted item the inventory has most of), material rows, placement order
(air, then blocks per layer starting from supported cells, then attachments, doors last),
`cellState`/`diffCells` for resume and refusal, and `chooseSite` over scanned columns.

`construction.ts` scans columns (ground, clutter, logs, player blocks), picks a site within 10
blocks of the requester (not on their spot, outside protected zones and a spawn keep-out),
refuses if the footprint has anything player-made, guards the box from pathfinder digging and
scaffolding while it works, digs natural bumps and plants when it may, places the door from
outside, and saves `build.active` so a re-run or a resumed (preempted) build uses the same
spot. Results are ok only when every required block is in place.

## Prerequisites

`toolkit.ts`: `ensureTool(kind, { minTier, cheapOnly })` crafts the best tier the materials
allow (planks from logs, sticks, a table through the existing crafting code, now exported as
`craftItem`). `materials.ts`: `planWood()` turns a shopping list into logs/planks/sticks/table
and decides on an axe for big jobs; `gatherMaterials()` chops with `fellTree` (exported from
woodcutting), crafts, mines with `collectBlocks` (exported from gather), and reports what is
still missing and why.

## Core changes

- `goto()` in `src/core/helpers.ts`: on abort it still calls `pathfinder.stop()`, and if the
  pathfinder hasn't settled 2 s later it clears the goal and rejects. Seen live: a wedged
  pathfinder (goal set, not moving) never settled after `stop()`, so `gotoWithin`'s timeout
  never fired and `gather_materials` hung for minutes. Callers see the same errors as before.
- `BotTools.define()` (tools.ts), a `goal` trigger kind and prompt section (prompt.ts), goal
  wiring in runtime.ts and the brain, `llm.goals` in the profile schema. All additive.
- `craftItem`, `fellTree`, `collectBlocks` exported from their skills (bodies of existing
  actions, behaviour unchanged apart from the tool wiring).

## Trade-offs

- Site search uses a square footprint for non-square blueprints (conservative, simpler).
- Continuation spends turns; the reserve and the stall backoff keep a goal from eating the
  whole hourly budget, and every limit renews only when the owner speaks.
