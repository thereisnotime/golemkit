# diagnostics Specification

## Purpose
Diagnostics for running bots: the opt-in memory log that shows where a process's memory goes (heap, native, swap, child processes, per-agent counts).

## Requirements

### Requirement: Opt-in memory log
When `GOLEM_MEMLOG` is set to a positive number of seconds (at least 5), `run` and `fleet` SHALL log one `memlog` line about the process every that many seconds (RSS, JS heap used and total, external and array-buffer memory, RSS outside the heap, swap, and the count and summed RSS of child processes where `/proc` exists) and one line per agent with cheap counts (the adapter's own, e.g. loaded chunk columns, entities, players, listener counts; the agent's storage keys and size, journal buffer, chat queue). When it is unset, empty, zero or not a number, no timer SHALL run and nothing SHALL be logged.

#### Scenario: Off by default
- **WHEN** `just run pax` starts without `GOLEM_MEMLOG`
- **THEN** no `memlog` line is logged

#### Scenario: Every minute
- **WHEN** `GOLEM_MEMLOG=60` is set
- **THEN** a `memlog rss ...` line and a `memlog Pax chunks=... entities=...` line are logged about once a minute

#### Scenario: Too small
- **WHEN** `GOLEM_MEMLOG=1` is set
- **THEN** the log runs every 5 seconds
