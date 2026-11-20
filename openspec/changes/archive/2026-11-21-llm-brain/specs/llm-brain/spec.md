## ADDED Requirements

### Requirement: Tools for language models
The LLM brain SHALL expose every non-internal action as a tool, plus `observe`, `reply`, `say`, `whisper`, `recent_chat`, `remember` and `recall`, and SHALL run actions through `agent.act()` with caller `brain:llm` at `PRIORITY.llm`.

#### Scenario: Action at LLM priority
- **WHEN** the model calls `goto` with `{x: 1, z: 2}` during a turn triggered by Steve
- **THEN** the agent runs `goto` at priority 30 with Steve as the requesting player and the model gets the action result as text

#### Scenario: Busy body
- **WHEN** a player's command holds the body and the model calls an exclusive action or `stop`
- **THEN** the call is refused with a busy result the model can read, and the player's action keeps running

#### Scenario: Long-running action
- **WHEN** the model calls `follow`
- **THEN** the tool returns "started follow" within about 1.5 s and the action keeps running after the turn ends

### Requirement: MCP bridge
The tool set SHALL be available as an MCP server: in-process for SDK clients and over streamable HTTP bound to 127.0.0.1 with a bearer token.

#### Scenario: Unauthorized request
- **WHEN** an HTTP request reaches the bridge without the bearer token
- **THEN** it is rejected with 401 and no tool runs

#### Scenario: Tool listing
- **WHEN** an MCP client lists tools
- **THEN** it gets every action and built-in tool with its JSON schema

### Requirement: Providers
The brain SHALL drive a model through a provider interface, with providers `claude-subscription`, `codex`, `anthropic`, `opencode` and `openai`, each reporting a clear reason when it can't run.

#### Scenario: Missing login or key
- **WHEN** the configured provider is not logged in, not installed or lacks its key
- **THEN** the brain logs why at startup and skips turns instead of crashing

#### Scenario: Subscription not billed to an API key
- **WHEN** `claude-subscription` runs while `ANTHROPIC_API_KEY` is set and `MC_CLAUDE_ALLOW_API_KEY` is not true
- **THEN** the key is removed from Claude Code's environment, and the turn aborts if Claude Code still reports an API key as its credential source

#### Scenario: CLI agents only get bot tools
- **WHEN** a CLI provider (claude, codex, opencode) runs a turn
- **THEN** built-in shell, file-editing and web tools are disabled or denied, the working directory is an empty scratch directory, and the user's global CLI configuration is not modified

### Requirement: Triggers
The brain SHALL start a turn when an allowed player mentions the bot's name or an alias in public chat or whispers it, and optionally on events (hurt, death, player joined) and on an idle timer. Messages starting with the command prefix SHALL be left to the command brain.

#### Scenario: Mention
- **WHEN** Steve says "hey buddy, come here" and the bot is Buddy
- **THEN** one LLM turn runs for Steve's message

#### Scenario: Not addressed
- **WHEN** someone says "buddyfoo is cool" or "nice weather"
- **THEN** no turn runs

#### Scenario: Command
- **WHEN** a player whispers `!follow`
- **THEN** the LLM brain ignores it

### Requirement: One turn at a time
Each bot SHALL run at most one LLM turn at a time; further triggers queue (bounded, chat before ticks and events) and several messages from the same player are merged.

#### Scenario: Burst of messages
- **WHEN** Steve sends three messages and Alex one while a turn runs
- **THEN** the provider never runs concurrently, Alex gets a turn, and Steve's pending messages are answered in one turn

### Requirement: Guardrails and budgets
The brain SHALL cap model round trips, tool calls, chat messages and wall-clock time per trigger, and SHALL enforce configurable turn, token and dollar budgets per hour and tokens and dollars per day.

#### Scenario: Tool call cap
- **WHEN** the model makes more tool calls than `maxToolCalls` in one turn
- **THEN** the extra calls fail with a limit message and don't reach the agent

#### Scenario: Budget exhausted
- **WHEN** a budget is used up
- **THEN** turns are skipped, the brain logs it once and tells the first player who talks to it once, and turns resume when the budget allows

#### Scenario: Subscription dollars
- **WHEN** a subscription provider reports a list-price cost estimate
- **THEN** it does not count toward dollar budgets

### Requirement: Memory
The brain SHALL keep recent chat and events in a short-term buffer that rolls older entries into a summary, and long-term notes in agent storage that the model writes with `remember` and searches with `recall`.

#### Scenario: Notes survive restarts
- **WHEN** the model remembers "Steve's base is at 100 64 200" and the bot restarts
- **THEN** a later `recall` for "steve base" returns the note

### Requirement: Usage accounting
The brain SHALL record per turn the input, output, cache-read and cache-write tokens, tool calls, duration, provider and model; estimate tokens when a provider reports none and mark them estimated; price API turns from an overridable table; report subscription turns as "subscription"; and keep since-start, daily and all-time totals per bot and provider in agent storage.

#### Scenario: Turn log
- **WHEN** a turn finishes
- **THEN** an info log line like `llm turn: 1.2k in / 180 out / 900 cached, 3 tools, 4.1s, ~$0.005` is written with the numbers as structured fields, and the agent emits `llmUsage`

#### Scenario: Chat summary
- **WHEN** a player says `!llm_usage`
- **THEN** the bot answers with one line of today / since start / all time usage

#### Scenario: Estimated usage
- **WHEN** a provider returns no token counts
- **THEN** tokens are estimated at four characters per token and the turn is marked estimated
