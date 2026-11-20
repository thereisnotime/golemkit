## 1. Bridge and tools

- [x] 1.1 BotTools: catalog actions + observe/reply/say/whisper/recent_chat/remember/recall
- [x] 1.2 LLM priority, background start for long-running actions, short-action timeout
- [x] 1.3 Per-turn tool/chat caps, `stop` guard, no calls outside a turn (unless exposed)
- [x] 1.4 MCP server over BotTools; streamable HTTP bridge on 127.0.0.1 with bearer token

## 2. Providers

- [x] 2.1 Provider interface and env-driven registry
- [x] 2.2 anthropic: tool loop, cache breakpoints, refusal fallback
- [x] 2.3 claude-subscription: Agent SDK (in-process MCP) and `claude -p`; API key stripping and check
- [x] 2.4 codex: `codex exec` with per-invocation overrides, sandbox flags verified
- [x] 2.5 opencode (untested, V2 config, V1 fallback)
- [x] 2.6 openai-compatible chat completions

## 3. Brain

- [x] 3.1 Triggers: mention, whisper, all chat, events, tick; owners only; cooldown and coalescing
- [x] 3.2 One turn at a time, bounded queue, chat before ticks
- [x] 3.3 Prompt building (static system, volatile user message)
- [x] 3.4 Short-term ring buffer with rolled-up summary, long-term notes in storage
- [x] 3.5 Hourly and daily budgets, pause with a single notice

## 4. Usage accounting

- [x] 4.1 TurnUsage per turn with cache tokens, tool calls, duration, provider, model
- [x] 4.2 Price table (overridable), subscription vs API cost reporting, estimation fallback
- [x] 4.3 Session / today / all-time totals per bot and provider, fleet totals
- [x] 4.4 `!llm_usage`, `observe().llm`, `llmUsage` event, structured log fields

## 5. Bots, scripts, docs, tests

- [x] 5.1 bots/companion.ts
- [x] 5.2 scripts/llm-smoke.ts; chat-test CHAT_DELAY_MS
- [x] 5.3 Unit tests (prompts, triggers, budgets, tools, MCP in-memory + HTTP, runtime, providers against fake servers, accounting)
- [x] 5.4 docs/guide/llm-brain.md, .env.example, README pointer, architecture note
- [x] 5.5 Smoke-tested codex; live test on mc02 with codex
