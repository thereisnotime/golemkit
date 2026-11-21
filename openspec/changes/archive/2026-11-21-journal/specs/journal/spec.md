## ADDED Requirements

### Requirement: Event capture for every bot
Every agent SHALL record typed journal events to `data/bots/<username>/journal/YYYY-MM-DD.jsonl`, one JSON object per line with `ts`, `type`, optional `pos` and `dim`, and `data`, independent of which brains it runs.

#### Scenario: Death with a server message
- **WHEN** the bot dies and the server sends "Pax was slain by Zombie Villager"
- **THEN** a `death` event is written with the position, `cause: slain`, `killer: Zombie Villager`, the health before the fatal hit, the action it was running and the inventory it carried as `lost`

#### Scenario: Death without a message
- **WHEN** no death message arrives within 3 seconds
- **THEN** the death is still recorded, with the last damage source as the cause

#### Scenario: Inventory changes are debounced
- **WHEN** several slot updates happen within 2 seconds (crafting logs into planks)
- **THEN** one `item_gained` and one `item_lost` event with the net change is written, and moving items between slots writes nothing

#### Scenario: Status actions skipped
- **WHEN** a non-exclusive action such as `pos` succeeds and `journal.actions.includeStatus` is false
- **THEN** no `action` event is written

#### Scenario: No secrets or prompts
- **WHEN** a chat line is `/login hunter2` or contains an environment secret
- **THEN** the journal stores `/login ***` or `***`, and `llm_turn` events carry only token counts

### Requirement: Volume caps
The journal SHALL cap each event type per minute (configurable) and write one `journal_dropped` event per type and minute with the number of dropped events.

#### Scenario: Chat flood
- **WHEN** 50 chat lines arrive in one minute and the `chat_in` cap is 40
- **THEN** 40 are written and one `journal_dropped` event says 10 were dropped

### Requirement: Rollups and retention
The journal SHALL build deterministic day rollups with hourly sections (`journal/rollups/YYYY-MM-DD.json`) when an hour or day closes and on demand, and SHALL delete raw files older than `retentionDays` only after a final rollup exists.

#### Scenario: Deterministic rollup
- **WHEN** the same events are rolled up twice, in any order
- **THEN** the rollups are identical: counts per type, deaths, net items, clustered places, players met, actions with top failures, online time and LLM tokens

#### Scenario: Retention keeps deaths
- **WHEN** a day's raw file is deleted by retention
- **THEN** `lastDeath()` and `recall_events` still report that day's deaths from the rollup

#### Scenario: Missing rollup
- **WHEN** a raw file is past retention but has no final rollup
- **THEN** it is not deleted

### Requirement: Optional LLM summary
When `journal.summarize` is configured the journal SHALL add a short paragraph to finished day rollups through the provider layer, sending only rollup numbers, with no tools and one turn. It SHALL be off by default.

#### Scenario: Fake provider
- **WHEN** a day closes and a provider is configured
- **THEN** the rollup gets `summary` and `summaryBy`, and the model input contains no chat text

### Requirement: Query API and actions
The journal SHALL answer queries by type, time range, position radius, player, text and limit over raw files and rollups, offer `lastDeath`, `deaths`, `whereWas` and `summary`, and fleet-wide queries over bots on the same server. The `journal` skill SHALL expose `recall_events`, `last_death`, `history` (non-exclusive) and `goto_death` (exclusive, long-running) as actions.

#### Scenario: Where did I die
- **WHEN** a player sends `!last_death` one minute after the bot died
- **THEN** the bot answers with the position, cause, what it was doing, what it lost and that the drops may still be there for about four more minutes

#### Scenario: Filtered recall
- **WHEN** `recall_events type=deaths,chat since=1h` runs
- **THEN** the reply lists matching events oldest first in one compact line, and the full events are in the result data

#### Scenario: Context observation
- **WHEN** a context pack is active, `journal.observe` is on and the bot died in the last 24 hours
- **THEN** `observe()` includes a `recentEvents` line with the death and how long ago it was
