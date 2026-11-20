## Context

Bots already expose every capability as an action with a zod schema, and `actionCatalog()`
turns that into JSON-schema tool definitions. Brains share the body through `agent.act()` and
priorities (llm = 30, between npc and player). The owner has Claude Code and Codex logged in
with subscriptions and wants those usable, not only API keys.

## Goals / Non-Goals

**Goals:** one provider interface the brain uses; CLI agents restricted to our tools; guardrails
that hold for every provider; honest usage numbers.

**Non-Goals:** multi-turn conversation state inside providers (continuity comes from memory in
the prompt), voice, vision, model-driven chat summarisation.

## Decisions

- **Tool set lives in one place (BotTools).** Guardrails (LLM priority, background start for
  long-running actions, `stop` refused against higher priority, per-turn tool and chat caps,
  no calls outside a turn) are enforced there, so they also hold for CLI agents that call over
  MCP. Alternative: per-provider limits; rejected because CLIs don't expose a tool-call cap.
- **Stateless HTTP MCP bridge on loopback with a bearer token,** a fresh MCP server per request.
  Stdio was skipped: the bot lives in our process, a stdio server would need a proxy process.
- **Claude subscription through the Agent SDK with an in-process SDK MCP server.** `tools: []`,
  strict MCP config, `allowedTools: ['mcp__minecraft']`, `permissionMode: 'dontAsk'`,
  `settingSources: []`, `persistSession: false`. Claude Code silently prefers
  `ANTHROPIC_API_KEY`, so it is removed from the child env and the init message's
  `apiKeySource` is checked (abort unless `allowApiKey`). `claude -p` mode kept as fallback.
- **Codex via `codex exec` with `-c` overrides and `--ignore-user-config`** so the user's
  config.toml is neither modified nor loaded; MCP token passed by env
  (`bearer_token_env_var`). `code_mode_host` must stay enabled: Codex routes MCP calls through
  code mode, disabling it made our tools unreachable (verified).
- **Static system prompt, volatile user message.** Lets the Anthropic provider cache tools +
  system with two breakpoints.
- **Usage accounting in the runtime, not providers.** Providers report what they get; the
  runtime fills a `TurnUsage`, estimates (chars/4) when nothing was reported, prices API turns
  from an overridable table, and records into daily buckets in `agent.storage`. Subscription
  turns are reported as "subscription"; Claude Code's own list-price estimate is kept separately
  and doesn't count toward dollar budgets.
- **Core changes kept to optional hooks:** `BrainDef.observe` (merged into `agent.observe()`
  like skills) and an `llmUsage` event type (type-only import from `src/llm/usage.ts`).

## Provider matrix

| Provider | Auth | Tool mechanism | Sandboxing | Tested |
|---|---|---|---|---|
| claude-subscription | `claude` login / `CLAUDE_CODE_OAUTH_TOKEN`; API keys stripped, apiKeySource checked | Agent SDK + in-process SDK MCP (or HTTP bridge, or `claude -p --mcp-config`) | no built-in tools, strict MCP, dontAsk, no settings/hooks/plugins, empty cwd | wiring verified (tools, MCP connected, auth none, key stripping); no model turn (login expired) |
| codex | `codex login` (ChatGPT) | `codex exec`, `-c mcp_servers.minecraft.*` | ignore user config, shell/exec/browser/computer/plugins/hooks off, web search off, read-only sandbox, ephemeral | smoke + live server |
| anthropic | `ANTHROPIC_API_KEY` | Messages API tool loop | n/a (only our tools) | fake-server unit test |
| opencode | `opencode auth login` | `opencode --standalone run`, project `opencode.jsonc` (V2) | agent permissions deny `*`, allow `minecraft_*` | untested |
| openai | optional key | chat completions tools | n/a | fake-server unit test |

## Risks / Trade-offs

- Subscription terms may not cover a bot other players talk to → documented, budgets default on.
- CLI agents add large fixed prompts (Codex ~30k input tokens per turn, mostly cached) → turns
  and token budgets; API provider recommended for heavy use.
- OpenCode V2 config is from docs only → marked untested, V1 schema switch available.
- Codex leaves some built-ins (code-mode exec, apply_patch, sub-agents) → read-only sandbox,
  no shell; documented.
