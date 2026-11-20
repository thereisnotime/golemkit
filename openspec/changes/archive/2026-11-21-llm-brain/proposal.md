## Why

mc-buddy's action catalog was built so a language model could use it, but nothing drives a bot
with a model yet. The owner wants LLM bots on the subscriptions they already pay for (Claude
through Claude Code, ChatGPT through Codex, OpenCode), with API keys as an option, and without
those agent CLIs getting shell or file access on the host.

## What Changes

- MCP bridge: a bot's actions plus observe/chat/memory tools as an MCP server (streamable HTTP
  on 127.0.0.1, bearer token; in-process for the Claude Agent SDK).
- Provider interface with five providers: `claude-subscription` (Agent SDK or `claude -p`),
  `codex` (`codex exec`), `anthropic` (Messages API tool loop with prompt caching), `opencode`
  (untested), `openai` (OpenAI-compatible chat completions).
- `llmBrain()`: chat/whisper/event/tick triggers, one turn at a time, LLM priority, background
  start for long-running actions, per-turn tool/chat/turn limits, hourly and daily budgets,
  short-term and long-term memory.
- Usage accounting: tokens (incl. cache), tool calls, duration and cost per turn, per bot
  (since start, today, all time, persisted) and per fleet; `!llm_usage`, `observe().llm`,
  `llmUsage` agent event.
- `bots/companion.ts`, `scripts/llm-smoke.ts`, `docs/guide/llm-brain.md`.
- Small backwards-compatible core changes: optional `observe()` on brains, `llmUsage` event
  type on the agent, `commandBrain({ whisperNeedsPrefix })`, `CHAT_DELAY_MS` in chat-test.

## Capabilities

### New Capabilities
- `llm-brain`: language-model brain, its providers, MCP bridge, guardrails, memory and usage
  accounting.

### Modified Capabilities

## Impact

- New code under `src/llm/` and `src/brains/llm.ts`; touches `src/core/agent.ts`,
  `src/core/brain.ts`, `src/brains/command.ts`.
- New dependencies: `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`,
  `@anthropic-ai/claude-agent-sdk`.
- New env vars (`MC_LLM_*`, `MC_CLAUDE_*`, `MC_CODEX_*`, `MC_OPENCODE_*`, `MC_OPENAI_*`,
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), documented in `.env.example`.
