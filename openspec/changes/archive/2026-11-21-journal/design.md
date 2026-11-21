## Context

Agents already emit events for chat, server messages, actions and LLM usage, and each session
has a mineflayer bot with death, health, inventory and entity events. Storage is a JSON
key/value file per bot. The journal has to work for every bot regardless of brains and stay
small on a busy server.

## Decisions

- **Core, not a brain.** `Agent` builds a `Journal` (storage, limits, rollups, queries; no bot
  needed, so it is unit-testable) and a `JournalCapture` (wiring). The capture subscribes to
  agent events once and to the bot per session. A `goal` agent event is listened to without
  adding it to `AgentEvents`, so the goals work can emit it later without conflicts.
- **Append-only JSONL per local day.** One line per event `{ts, type, pos?, dim?, data}`.
  Buffered and written every `flushMs` (2 s) with `appendFileSync`; deaths flush immediately.
- **Volume control in pure classes** with injected time: `RateLimiter` (per type per minute,
  drops counted and written as one `journal_dropped` event), `InventoryTracker` (net diff after
  2 s of quiet, at most 15 s), `DamageAggregator` (10 s windows per source), `BlockAggregator`
  (per chunk column, 30 s). Status actions that succeed are skipped by default.
- **Deaths.** The death message can arrive just before or after mineflayer's `death` event, so
  recent parsed messages are kept for 3 s and a death waits up to 3 s for its message. The
  current action is tracked from `actionStart` because the agent's own death handler stops
  actions first. The inventory at death is the lost-items list; `respawn` records whether the
  inventory was kept.
- **Kills and placed blocks** need wrappers on `bot.attack` and `bot.placeBlock` for the
  session (restored on cleanup); mineflayer has no events for them.
- **Rollups are pure functions** of the events (code-point sorting, keys `HH:00` so JSON key
  order is stable). Deaths are stored in full in the rollup so they survive retention. Online
  time comes from connect/disconnect pairs.
- **Maintenance** runs 5 s after start, hourly (today's rollup) and when the day changes:
  final rollups for past days, retention (raw only with a final rollup), summaries.
- **LLM summary** uses `createProvider` through a dynamic import, so the LLM layer only loads
  when `journal.summarize` is configured. The model gets the rollup numbers only, no chat text,
  no tools, one turn.
- **Queries** read raw files for the days in range and fall back to rollup deaths plus a day
  summary event for days whose raw file is gone.
- **Secrets.** String values pass through the logger's redaction; `/login`-style commands are
  masked; prompts and responses are never recorded (only token counts).

## Risks / Trade-offs

- Sync file IO on flush is small but blocks the event loop briefly; fine at the capped volume.
- Local-time hour sections are approximate on DST change days.
- Death messages are parsed in en_us vanilla wording only; modded or translated messages fall
  back to the last damage source.
