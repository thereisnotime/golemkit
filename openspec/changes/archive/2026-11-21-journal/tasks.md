## 1. Core
- [x] 1.1 Types, config (settings.journal, profile `journal:`, env)
- [x] 1.2 Death and advancement message parsing
- [x] 1.3 Rate limiter, inventory tracker, damage and block aggregators
- [x] 1.4 Journal storage: buffered JSONL writes, caps, redaction
- [x] 1.5 Capture from agent events and the session bot; agent wiring (`agent.journal`, `chatOut`, `protectedArea`)

## 2. Rollups
- [x] 2.1 Deterministic day rollups with hourly sections
- [x] 2.2 Hourly/day-close maintenance, retention
- [x] 2.3 Optional LLM summary via the provider layer

## 3. Queries and actions
- [x] 3.1 query, lastDeath, deaths, whereWas, summary, fleetQuery
- [x] 3.2 journal skill: recall_events, last_death, history, goto_death; standardSkills
- [x] 3.3 observe() recent-events line with a context pack

## 4. Verification and docs
- [x] 4.1 Unit tests (parsing, diffs, caps, rollups, retention, queries, actions, summary)
- [x] 4.2 Live test on mc02 as JournalTest
- [x] 4.3 docs/guide/journal.md, profiles.md, sidebar, README, actions reference
