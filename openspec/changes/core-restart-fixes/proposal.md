# Core restart fixes

## Why

Two small core issues seen during benchmarking: a stopped Agent can never be started again
(`stopping` is never reset), and `scripts/docs-interlink.ts` keeps adding a redundant link to
`docs/guide/live-config.md`.

## What changes

- Reset the stop state so `agent.start()` works after `agent.stop()`.
- Make docs-interlink skip a term already linked in the same paragraph.

## Status

Proposed, not started.
