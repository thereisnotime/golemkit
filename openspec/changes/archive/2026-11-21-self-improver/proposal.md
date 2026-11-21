## Why

NPC bots either run fixed code (npcBrain) or need an LLM in the loop for every decision
(llmBrain), which costs tokens all the time. We want an NPC that runs on its own for free and
only uses an LLM when its owner wants it to behave differently, without ever letting chat
(untrusted input) turn into executable code.

## What Changes

- New brain `selfImprover()` (src/brains/self/) that runs a declarative, versioned program
  through the existing NpcController, so it inherits scoring, cooldowns and back-off.
- New program format: rules (utility behaviours), routines (bounded step lists), triggers
  (interval, game time, chat words, hurt, death, player joined, spawn), variables and timers,
  validated with zod against the live action catalog.
- Owner instructions (chat prefix, whisper, `!teach`, inbox file) run one LLM step that
  returns a full program or patch via a `submit_program` tool; every submission passes a gate
  (validation, catalog and static limits, dry run) with up to N repair rounds.
- Program versions stored under `data/bots/<username>/programs/vNNN.json`, with
  `program_status/show/history/rollback/reset/explain/teach` actions.
- Experience counters: repeated failures make the bot ask its owner before reworking a rule.
- New variant `variants/apprentice.ts` and profile `profiles/apprentice.yaml`.
- No core changes.

## Impact

- New code in src/brains/self/, variants/apprentice.ts, profiles/apprentice.yaml,
  scripts/teach-test.ts, tests, docs/guide/self-improver.md.
- Reuses src/llm providers, Budget and UsageTracker (usage lands in the bot's `llm.usage`).
