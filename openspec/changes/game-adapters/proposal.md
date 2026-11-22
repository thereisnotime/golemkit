# Game adapters

## Why

The framework only plays Minecraft Java, but most of it isn't about Minecraft: the LLM brain
(providers, goals, budgets, quota pause, token tracking), context packs, the intent pipeline,
actions with zod schemas, the action lock with priorities, brains sharing one body, armable
behaviours, utility-AI scoring, live toggles, the journal and fleets. Today they reach the game
through `Agent`, which wraps a Mineflayer bot, so none of it can drive a bot in another game.
A measured split: 23 of 25 LLM files and all 6 context files don't touch the game, while 17 of
36 core files and 38 of 45 skill files do.

## What changes

- A game-agnostic core: agent lifecycle, action lock, chat queue, storage, toggles, journal,
  logging, fleets. No Mineflayer import.
- A `GameAdapter` interface that the core talks to: connect and reconnect, identity, chat in and
  out, an observation snapshot, a small set of primitives, and events.
- `adapters/minecraft-java`: today's Mineflayer agent and the NeoForge layer behind that
  interface, with no behaviour change. Minecraft skills move with it.
- Brains, the LLM runtime, intents and behaviours depend only on the core and on capabilities
  an adapter declares, so a bot on a game without, say, digging simply doesn't get dig actions.
- A second, small adapter to prove the split (candidate: Minecraft Bedrock via
  `bedrock-protocol`, or Luanti), plus an adapter author guide.

## Status

Proposed, not started.
