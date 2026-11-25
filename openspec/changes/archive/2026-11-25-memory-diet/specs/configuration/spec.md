## ADDED Requirements

### Requirement: LLM SDKs load on first use
The Anthropic SDK, the Claude Agent SDK and the MCP SDK SHALL NOT be loaded when a bot starts. The `anthropic` provider SHALL load its SDK on its first turn, `claude-subscription` in SDK mode SHALL load the Agent SDK and the MCP SDK on its first turn, and the LLM brain SHALL load the MCP SDK only when it starts the HTTP bridge (a provider that needs MCP, or `mcp.expose`). Turns, errors and the bridge SHALL behave as before.

#### Scenario: Idle bot with an LLM brain
- **WHEN** a profile with `llm.provider: claude-subscription` runs and nobody talks to it
- **THEN** none of `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` is loaded

#### Scenario: First turn
- **WHEN** the first LLM turn starts
- **THEN** the provider's SDK is loaded then and the turn runs as before

### Requirement: Launcher memory defaults
`just run`, `just dev` and `just fleet` SHALL set `NODE_COMPILE_CACHE` (default `node_modules/.cache/node-compile`, kept when already set) and start Node with `GOLEM_NODE_FLAGS` (default `--max-semi-space-size=8`; empty for V8's defaults). The container image SHALL set `NODE_COMPILE_CACHE=/app/.cache/node-compile` and start Node with `--max-semi-space-size=8`. When `NODE_COMPILE_CACHE` is set, `run` and `fleet` SHALL flush the compile cache once, a minute after the bots start.

#### Scenario: Second start
- **WHEN** `just run pax` starts a second time with unchanged sources
- **THEN** Node reads the type-stripped modules from the compile cache and does not load the TypeScript stripper

#### Scenario: V8 defaults
- **WHEN** `GOLEM_NODE_FLAGS= just run pax` is used
- **THEN** the bot process starts without `--max-semi-space-size`
