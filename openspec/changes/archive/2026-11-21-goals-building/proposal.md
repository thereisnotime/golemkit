# Goals and building

## Why

Pax was asked several times to "make an axe, chop trees and build us a small house" and
failed every time. Its log shows why:

- Nothing kept the request between turns. Each turn only saw recent chat, and short-term
  memory is lost on restart, so after a reconnect it answered "I have no active task".
- It could only place one block per tool call, so it judged a house impossible.
- Nothing made tools first: `chop_tree` and `collect` dug by hand, and making an axe took
  three separate tool calls the model had to remember.
- Turns only started when someone talked to it, so every multi-step job stalled after the
  first action.

## What changes

- Persistent goals for the LLM brain (`src/llm/goals.ts`): `set_goal`, `update_goal`,
  `complete_goal`, `abandon_goal`, `goal_status`. Stored in `agent.storage`, shown near the
  top of every prompt and in `observe()`.
- Continuation: while a goal is active and the bot is idle, the runtime starts follow-up
  turns (after an action ends, short or long, after a turn that made progress, and on an
  idle check with backoff). Guardrails: a turn limit and a timeout without owner input,
  stopping on repeated identical failures, keeping a share of the hourly budget, and the
  owner's `!stop` / `!goal_cancel`. Configurable in the profile (`llm.goals`).
- Building from data: blueprints in `blueprints/*.yaml` (hut, shelter, wall_segment,
  platform, tower), validated with zod. `build` places a whole structure on a flat, natural,
  unprotected site near the requester, in floor/walls/roof/torch/door order, skips blocks
  already in place (resume) and reports the real count. `build_plan` lists materials and the
  site.
- Prerequisites: `ensureTool(kind)` crafts the best tool the inventory allows; `chop_tree`
  makes an axe, `collect` and `break_block` make a pickaxe for stone. `gather_materials`
  chops, crafts planks, sticks, doors and tools and mines simple blocks for a shopping list
  or a blueprint.
- Prompt rules that steer the model to goals and high-level actions; Pax and the companion
  variant configure goal limits.

## Non-goals

- No general recursive crafting planner: wood products and a few mined blocks only.
- No smelting for torches (charcoal); torches and glass are optional parts of the hut.
- No scaffolding or ladders: structures stay low enough to place from the ground or inside.
