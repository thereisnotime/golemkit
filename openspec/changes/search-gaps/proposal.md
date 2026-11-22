# Search gaps

## Why

The search skill shipped with known gaps: `bring_item` can't hunt or shear, `fetch_drops` picks up
everything near the death spot, `bring_item` starts over when a reflex preempts it, and several
runs were never re-verified live after the last fixes.

## What changes

- Hunting and shearing as gather sources (meat, leather, wool, feathers).
- `fetch_drops` prefers items that appeared near the death spot within seconds of the death
  message and reports anything else it picked up.
- `bring_item` resumes from its last completed step after a preemption.
- Live re-runs: find sheep, bring oak planks, bring bread, the strict pickup check.

## Status

Proposed, not started.
