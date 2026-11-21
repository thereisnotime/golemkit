## 1. Pack loading and layout

- [x] 1.1 `src/context/pack.ts`: load files from stacked dirs, strip comments, caps, exclude list
- [x] 1.2 Prompt layout via `PromptContext` in `buildSystemPrompt` (unchanged without a pack)
- [x] 1.3 `ContextHandle`: per agent, debounced hot reload, debug logging, `context_status`
- [x] 1.4 Profile `context:` key, sibling auto-discovery, variant `contextDefaults`

## 2. Memory

- [x] 2.1 `NoteStore` in `Memory`; `MemoryFile` with dedup, pinned lines, caps and compaction
- [x] 2.2 One-time migration from `llm.notes`; runtime skips notes in the user message when memory is in the prompt

## 3. Skills and hooks

- [x] 3.1 Skill parsing, index, `list_skills`/`read_skill` via `BotTools.addTool`, action validation
- [x] 3.2 `hooks.yaml` schema and `HookEngine` (conditions, cooldown, once, owner-only, templates)
- [x] 3.3 `hooksBrain()` with bot events, timers and `llmBudgetExhausted` (runtime `onPause`)
- [x] 3.4 `spawnPoint` in `observe()`; companion runs `hooksBrain()`

## 4. Pax pack

- [x] 4.1 AGENTS.md, USER.md, skills gather-wood and come-to-me, hooks.yaml

## 5. Eval

- [x] 5.1 Scripted world and fake actions, scenarios and checks
- [x] 5.2 Harness, aggregation, markdown/JSON report, scripted dry provider
- [x] 5.3 `scripts/llm-eval.ts` with `--yes` guard and `just llm-eval`
- [x] 5.4 Tiny real A/B on the subscription (12 runs)

## 6. Docs and tests

- [x] 6.1 `docs/guide/context-pack.md` with diagrams, sidebar entry, README line
- [x] 6.2 Unit tests: loading/order/caps, skills, MEMORY.md, hooks, dry eval
