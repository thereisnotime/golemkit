## Context

The NPC brain already has scoring, hysteresis, failure back-off and back-off from other
callers. Behaviours build on it instead of forking it.

## Decisions

- **Definitions produce NPC behaviours.** `create(options)` returns a Behavior body; the
  runtime adds name and priority. `hook(options)` covers per-tick hooks (greetings).
- **Dynamic sets in the controller.** `NpcOptions.behaviors`/`hooks` accept a function, re-read
  every tick; stats are created lazily. `cancel(name)` stops a disarmed behaviour.
- **Per-behaviour priority.** `Behavior.priority` overrides the brain's. The controller tracks
  a pause level: a holder at priority P pauses behaviours at or below P only. Homogeneous sets
  behave exactly as before. Own higher-priority actions (the interrupt after a switch) are
  waited out instead of being treated as a foreign holder, and preempted long-running actions
  of ours are dropped on yield so the agent does not resume them without a behaviour.
- **PRIORITY.behavior = 35.** Survival behaviours must run while an LLM (30) holds the body,
  but stay below hooks (40), players (50) and reflexes (60). Additive, no existing caller
  changes.
- **Config vs runtime.** Config (variant defaults merged with profile) is the base; runtime
  changes are stored under `behaviors` in agent.storage and win. `behavior_reset` drops them.
- **Validation.** Schemas are strict (unknown keys rejected) with a common `priority` option.
  The CLI validates a profile's `behaviors:` before connecting; the brain validates again.
- **Permissions.** Player callers must be owners; any caller acting for a non-owner player is
  refused. LLM changes are recorded as `brain:llm`.
- **keep_fed** is a loop over a pure `nextFoodStep(world, options, tried)`: eat ready food,
  cook raw food, bake bread, eat safe raw food, withdraw from known chests, harvest, hunt.
- **hunt** filters with a pure `huntRefusal`: listed passive animals only, never players,
  villagers, pets, named, tamed, leashed or baby animals; skips protected areas and (by
  default) fenced animals.

## Risks

- A custom registry is not seen by the CLI's early validation (it uses the built-in one).
- `light_area` relies on block light data from the server.
- villager.ts keeps its own npcBrain: its fight-or-flee and social behaviours have no exact
  registry equivalent.
