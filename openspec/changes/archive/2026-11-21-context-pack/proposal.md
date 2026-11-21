## Why

LLM bots get all their behaviour from one persona string and a few code-side rules. The owner
wants the useful part of the SOUL.md / AGENTS.md / SKILL.md / hooks idea: operational rules,
facts about the owner, persistent memory, reusable procedures and deterministic reactions,
kept per profile as files. These only matter if the framework loads them explicitly, and they
are only worth their tokens if a measurement shows they change outcomes.

## What Changes

- Context pack directory per profile (`profiles/<name>/`, or `context:` in the profile;
  variant defaults via `settings.contextDefaults`): `AGENTS.md`/`RULES.md`, `IDENTITY.md`,
  `SOUL.md`, `USER.md`, `MEMORY.md`, `skills/`, `hooks.yaml`. Loaded with per-section and
  total caps, laid out in a fixed, cache-friendly order, hot reloaded, logged.
- `MEMORY.md` becomes the authoritative note store when a pack is active: `remember` appends
  with dedup, a size cap and deterministic compaction; storage notes migrate once.
- Skills with progressive disclosure: index in the prompt, `list_skills`/`read_skill` tools,
  action names validated against the catalog.
- `hooksBrain()`: deterministic event -> action rules from `hooks.yaml`, no LLM, at priority 40.
- `context_status` action.
- A/B eval harness (`src/llm/eval/`, `scripts/llm-eval.ts`, `just llm-eval`): scenarios in a
  scripted world against the fake agent, arms with/without a pack or file, report with success,
  tool calls, latency, tokens and cost; `--dry` scripted provider; real providers need `--yes`.
- Pax gets a real pack (AGENTS.md, USER.md, two skills, hooks.yaml).

## Capabilities

### New Capabilities
- `context-pack`: loading, prompt layout, memory file, skills, hooks and the A/B eval.

## Impact

- Additive options in `src/llm` (prompt context, note store, extra tools, `onPause`), a
  `context` profile key, `spawnPoint` in `agent.observe()`, `observation` override on the fake
  agent, `hooksBrain()` in the companion variant. Without a pack, prompts are unchanged.
