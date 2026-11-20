// Shared types for the LLM layer: the tool set a model sees, the provider interface the
// brain talks to, and what a turn returns.

/** One tool as a model sees it (JSON schema input, plain-text result). */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A tool call made during a turn, for logs, tests and the smoke script. */
export interface ToolCallRecord {
  name: string
  args: unknown
  ok: boolean
  result: string
  ms: number
}

/** Token usage as a provider reports it for one turn. */
export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number
  outputTokens: number
  /** Subsets of inputTokens, when the provider reports them. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** A cost the provider itself reported (Claude Code's total_cost_usd). Priced from the table otherwise. */
  costUsd?: number
  /** Model that actually served the turn, if known. */
  model?: string
}

/** The bot's tools, callable directly (API providers) or through the MCP bridge (CLI providers). */
export interface ToolHost {
  list (): ToolSpec[]
  call (name: string, args: unknown): Promise<{ ok: boolean, text: string }>
}

export interface TurnInput {
  /** Static system prompt (persona, rules). Stable across turns so providers can cache it. */
  system: string
  /** Everything volatile: trigger, observation, recent chat, notes. */
  userMessage: string
  tools: ToolHost
  /** Set when the bot's MCP bridge is running; CLI providers connect their agent to it. */
  mcp?: { url: string, token: string, serverName: string }
  /** Upper bound on model round trips for this turn. */
  maxTurns: number
  timeoutMs: number
  signal: AbortSignal
}

export interface TurnResult {
  /** Final assistant text (may be empty if the model only used tools). */
  text: string
  usage?: Usage
  /** Provider-specific detail for logs (stop reason, session id, ...). */
  detail?: string
}

export interface LlmProvider {
  readonly name: string
  /** api: pay per token. subscription: flat plan, report tokens not dollars. local: own hardware / unknown price. */
  readonly billing: 'api' | 'subscription' | 'local'
  /** Configured model, if any (for logs and pricing). */
  readonly model?: string
  /** True when the provider drives tools through the MCP bridge instead of calling them in-process. */
  readonly needsMcp: boolean
  /** Returns null when usable, or a human-readable reason it isn't (missing binary, key, login). */
  check (): Promise<string | null>
  run (turn: TurnInput): Promise<TurnResult>
}

export class ProviderError extends Error {
  constructor (provider: string, message: string) {
    super(`${provider}: ${message}`)
    this.name = 'ProviderError'
  }
}
