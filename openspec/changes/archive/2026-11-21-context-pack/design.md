## Context

The LLM brain builds a static system prompt (persona + framework rules) and a volatile user
message (trigger, observation, recent chat, notes). Notes live in `agent.storage`. Profiles
are YAML; variants are code. Another agent is changing `src/brains/self/`, so changes to
shared LLM files stay small and additive.

## Goals / Non-Goals

**Goals:** files that do something measurable; explicit loading with sizes and token
estimates in the logs; a prompt that stays byte-stable between turns; deterministic hooks;
an eval that compares arms under identical provider, model, tasks and limits.

**Non-Goals:** executing anything from pack files; LLM-written memory summaries; statistical
machinery in the eval beyond means and counts.

## Decisions

- **Module `src/context/`**, used by both the LLM brain and the hooks brain through a
  per-agent `ContextHandle` (`contextFor(agent)`), so one pack, one watcher, one MEMORY.md.
  `src/llm` doesn't import it; the brain passes a `PromptContext` getter, a `NoteStore` and
  extra tools into `LlmRuntime`.
- **Layout:** header, AGENTS.md, identity/persona, framework rules, SOUL, USER, skill index,
  MEMORY. The request listed memory before the skill index; memory goes last because it is the
  only section that changes during play, so the cached prefix stays as long as possible.
  Layout is cached until a reload or a MEMORY.md change.
- **Caps** in characters (4 chars ~ 1 token), cut at line breaks with a marker; over the total,
  cut memory, skills, soul, user, identity, rules in that order.
- **MEMORY.md authoritative** when a pack is active (human-editable, re-read on mtime change).
  Dedup by normalised equality or same-topic containment / Jaccard >= 0.7 (update in place).
  Over caps: merge the oldest same-topic pair, then drop oldest unpinned. "Pinned" headings
  protect lines. One-time migration from `llm.notes`; storage copy kept as a backup.
  Default location `<last pack dir>/MEMORY.md`, gitignored.
- **Skills** are tools registered as BotTools built-ins (`addTool`, additive), so they share
  the per-turn tool limit and work over MCP for CLI providers.
- **Hooks** run at priority 40 (between llm 30 and player 50). Strict zod schema; `act`
  steps only name catalog actions; templates are plain substitutions. lowHealth is
  edge-triggered with hysteresis. `llmBudgetExhausted` comes from a new `onPause` runtime
  callback through a tiny per-agent bus.
- **Profile `context:`** string, list, false or object; relative paths resolve next to the
  profile, then the repo root, then cwd; the sibling dir is auto-discovered.
- **Eval** runs the real `LlmRuntime.runTurn` against `FakeAgent` with a scripted world, so
  prompt building, tools, limits and usage accounting are the production ones. Arms are
  interleaved. Per-turn limits come from the profile. The dry `ScriptedProvider` obeys rules
  only if their text is in the prompt: it validates plumbing, not models. Checks are scored
  even when a turn errors, reported separately from success.

## Risks / Trade-offs

- A bigger system prompt costs tokens every turn; the eval reports it per arm.
- MEMORY.md shared by two instances of one profile: documented, `memoryFile` to separate.
- Small-N real evals are anecdotal; the report says so.
- Skill tools are registered at startup only; timer hooks pick up changes next session.
