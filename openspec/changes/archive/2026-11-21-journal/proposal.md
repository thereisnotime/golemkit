## Why

When Pax died and its owner asked "don't you know where you died?", it couldn't answer: deaths
only went to the log file. Bots have no memory of what happened to them beyond the LLM's chat
window and MEMORY.md notes someone wrote on purpose.

## What Changes

- An event journal in core (`src/core/journal/`): every agent records typed facts (deaths with
  parsed cause and lost items, respawns, damage, kills, inventory diffs, blocks, chat, actions,
  players, places, advancements, protected areas, connects/disconnects, LLM turn usage, goals)
  to `data/bots/<username>/journal/YYYY-MM-DD.jsonl`, batched, rate capped per type per minute.
- Deterministic hourly/daily rollups in `journal/rollups/YYYY-MM-DD.json`, retention for raw
  files (only after the rollup exists), an optional LLM paragraph summary per day (off by default).
- A query API on `agent.journal` (query, lastDeath, deaths, whereWas, summary) plus `fleetQuery`.
- A `journal` skill in `standardSkills()` with `recall_events`, `last_death`, `history` and
  `goto_death`, which are chat commands and LLM tools automatically, and an observe() line with
  recent notable events when a context pack is active.
- Configuration through `settings.journal` / the profile `journal:` key and `MC_JOURNAL*` env.
- Core additions: `agent.journal`, two agent events (`chatOut`, `protectedArea`), `redactSecrets`
  exported from the logger.

## Impact

- Every bot writes a small amount of data under `data/bots/<username>/journal/`.
- `standardSkills()` gains four actions.
- No changes to `src/llm/*`.
