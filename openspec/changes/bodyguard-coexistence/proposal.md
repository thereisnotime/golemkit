# Bodyguard coexistence

## Why

At priority 35 an armed bodyguard keeps the body away from the LLM while the player is in sight,
and when the player goes offline at night `stay_safe` can still walk the bot home because the
escort only counts while the player is online.

## What changes

- A `yieldToLlm` option: when no threat is in range, the bodyguard drops to npc priority so LLM
  goals can use the body, and takes it back when a threat appears.
- When the player logs off, follow `whenGone` (stay or home) consistently, including at night.

## Status

Proposed, not started.
