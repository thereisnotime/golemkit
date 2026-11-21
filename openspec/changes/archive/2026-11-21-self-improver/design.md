## Context

The NPC brain already has a utility controller with back-off; the scene brain has a
data-driven, zod-validated format with path-carrying errors; src/llm has providers, budgets
and usage tracking. The self-improver combines them.

## Decisions

### Program format (format.ts)
- JSON with `version: 1`, `name`, `vars`, `rules`, `routines`, `triggers`.
- Steps and conditions are objects with exactly one kind key, parsed recursively (like scene
  beats) so errors carry paths: `routines.patrol[2].if.then[0].params.radius`.
- Steps: act, goto_place, say, whisper, wait, if/else, repeat (times <= 20), while (max
  required, <= 100), set, timer, run (no recursion, depth <= 4), fail.
- Conditions: fact comparisons over a fixed fact list, time windows, playerNear,
  hostileNear, has, elapsed, chance, all/any/not.
- `act` params are checked against the action's zod schema at load (unknown keys rejected);
  templates (`{player}`, `{bot}`, `{var.x}`) stay strings until run time.
- The LLM spec is generated from the same zod schemas plus the allowed actions.

### Safety model
- No code generation or evaluation anywhere: the interpreter knows a fixed set of step kinds.
- Effects only through `agent.act` (NpcController ctx.act, caller brain:self, PRIORITY.npc)
  and `agent.say/whisper` behind a per-program limiter.
- Action policy: DEFAULT_DENY (attack, guard, defend, chop_tree, till, place_block, drop,
  stop, say, craft, smelt, deposit, withdraw, llm_usage, npc_*), internal, `program_*` and
  long-running actions are refused; configurable allow/deny.
- Execution caps per routine run: 2000 steps, 5 minutes.
- Only owners change the program; an empty owner list means nobody (not everybody). The
  mutating actions refuse brain/reflex callers so an LLM brain can't rewrite the program.
- Chat triggers match whole words, no regex from program data.

### Integration with the NPC brain
Rules compile to Behaviors; fired triggers go into a queue served by one extra behaviour
scoring the trigger priority. The brain owns an NpcController per session and replaces it
when the program changes. No fork of the NPC brain.

### Gate
1. parseProgram: zod, catalog, deny list, references, placeholders, size/depth/recursion.
2. dryRun: every rule, trigger and routine runs in the real interpreter against four
   simulated worlds and two random seeds, with a fake host and a virtual clock; CapExceeded
   or bad params after template filling reject the program. A `fail` step is a legitimate
   outcome.

### LLM step
One tool, `submit_program({ program } | { patch })`. Submissions are gated inside the tool
call, so the model can repair in the same call; otherwise errors feed the next call, up to
`callsPerInstruction` (default 3). A JSON program in plain text is accepted as a fallback.
Budget and usage come from src/llm (Budget, UsageTracker, turnUsage, PriceTable). Provider
settings follow the profile's `llm:` block like llmBrain.

### Versioning
Accepted programs are written atomically to `programs/vNNN.json` with instruction, author,
parent, diff summary and usage; the active version is `self.program` in agent.storage.
Version 0 is the variant's base program. Rollback re-validates against the current catalog.

### Experience
Per rule/trigger counters (runs, failures, streak, yields). A streak of N failures asks an
online owner by whisper; only "yes" starts the LLM step. autoApply is off by default.

## Risks / Trade-offs
- Chat triggers can't tell bots from players; cooldowns and the limiter bound ping-pong.
- A dry run can't prove real-world success (paths, beds); runtime failures are handled by
  cooldowns and the experience counters.
- Sharing `llm.usage` with an llmBrain on the same bot merges their daily totals.
