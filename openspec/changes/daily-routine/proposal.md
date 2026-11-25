# Daily routine

## Why

NPC mode (when the LLM quota runs out) only arms woodcutting and depositing. A bot left alone
should keep a base running the way a player would.

## What changes

- A configurable daily routine: morning farm round, deposit into own chests when full, re-craft
  worn tools, gather what the base is short of, light up dark spots around home, sleep in a bed at
  night.
- Used as the NPC mode default when no `npcMode.arm` is configured.

## Status

Mostly absorbed by [needs-and-idle](../needs-and-idle/proposal.md): the routine is the `active`
idle mode's chore list, with per-chore time-of-day windows. Still open here: NPC mode using the
routine as its default arm set.
