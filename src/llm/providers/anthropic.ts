// Anthropic Messages API with a client-side tool-use loop over the bot's tools.
// Auth: ANTHROPIC_API_KEY (or whatever the SDK resolves: ANTHROPIC_AUTH_TOKEN, an
// `ant auth login` profile). Tools + system prompt are static per bot and cached.
import { resolveProxy } from './proc.ts'
// The SDK is loaded on the first turn, not at startup: a bot that never calls the API doesn't pay its memory.
import type Anthropic from '@anthropic-ai/sdk'
import { ProviderError, type LlmProvider, type TurnInput, type TurnResult, type Usage } from '../types.ts'

export interface AnthropicProviderOptions {
  model?: string
  /** low | medium | high | xhigh | max. Chat-style turns do well at low. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Per-response output cap. Chat turns are short. Default 4096. */
  maxTokens?: number
  apiKey?: string
  baseURL?: string
  /** 'caveman' or a gateway URL; sets baseURL. */
  proxy?: string
  /** Server-side refusal fallback (beta). Default on for models that support it. */
  fallbacks?: boolean
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'

const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  readonly billing = 'api' as const
  readonly needsMcp = false
  readonly model: string
  private readonly opts: AnthropicProviderOptions
  private client: Anthropic | null = null
  private sdk: typeof Anthropic | null = null

  constructor (opts: AnthropicProviderOptions = {}) {
    this.opts = opts
    this.model = opts.model || DEFAULT_ANTHROPIC_MODEL
  }

  /** Resolves `proxy` into baseURL once (starts caveman if needed). */
  private async ensureBase (): Promise<void> {
    if (this.client || !this.opts.proxy || this.opts.baseURL) return
    this.opts.baseURL = (await resolveProxy(this.opts.proxy))?.baseUrl
  }

  private async getClient (): Promise<Anthropic> {
    this.sdk ??= (await import('@anthropic-ai/sdk')).default
    this.client ??= new this.sdk({ apiKey: this.opts.apiKey, baseURL: this.opts.baseURL, maxRetries: 2 })
    return this.client
  }

  async check (): Promise<string | null> {
    if (!this.opts.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return 'no ANTHROPIC_API_KEY set (or use MC_LLM_PROVIDER=claude-subscription to use a Claude login)'
    }
    return null
  }

  async run (turn: TurnInput): Promise<TurnResult> {
    await this.ensureBase()
    const client = await this.getClient()
    const Sdk = this.sdk!
    const specs = turn.tools.list()
    const tools: Anthropic.Beta.BetaTool[] = specs.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      // One breakpoint after the last tool caches the whole tool list; the system block has its own.
      ...(i === specs.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
    }))
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: turn.system, cache_control: { type: 'ephemeral' } }]
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: turn.userMessage }]
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: this.model }
    const useFallbacks = this.opts.fallbacks ?? FALLBACK_MODELS.has(this.model)
    const deadline = Date.now() + turn.timeoutMs
    let text = ''
    let stop = ''

    for (let i = 0; i < turn.maxTurns; i++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { stop = 'timeout'; break }
      let res: Anthropic.Beta.BetaMessage
      try {
        res = await client.beta.messages.create({
          model: this.model,
          max_tokens: this.opts.maxTokens ?? 4096,
          system,
          tools,
          messages,
          ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
          ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
        }, { signal: turn.signal, timeout: remaining })
      } catch (e) {
        if (e instanceof Sdk.AuthenticationError) throw new ProviderError(this.name, 'authentication failed, check ANTHROPIC_API_KEY')
        if (e instanceof Sdk.RateLimitError) throw new ProviderError(this.name, 'rate limited, try again later')
        if (e instanceof Sdk.APIError) throw new ProviderError(this.name, `API error ${e.status ?? ''}: ${e.message}`)
        throw e
      }
      addUsage(usage, res.usage, res.model)
      // Append the full content (thinking blocks included) so the next request stays valid.
      messages.push({ role: 'assistant', content: res.content })
      text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('\n').trim()
      stop = res.stop_reason ?? ''
      if (res.stop_reason === 'refusal') break
      if (res.stop_reason !== 'tool_use') break

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue
        // Tool calls run one at a time: the bot has one body, parallel moves would preempt each other.
        const r = await turn.tools.call(block.name, block.input)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, is_error: !r.ok })
      }
      messages.push({ role: 'user', content: results })
      if (i === turn.maxTurns - 1) stop = 'max_turns'
    }
    return { text, usage, detail: stop }
  }
}

/** Sums the response's usage; cost is priced later from the price table (pricing.ts). */
function addUsage (u: Usage, r: Anthropic.Beta.BetaUsage, model: string): void {
  const cacheRead = r.cache_read_input_tokens ?? 0
  const cacheWrite = r.cache_creation_input_tokens ?? 0
  u.inputTokens += r.input_tokens + cacheRead + cacheWrite
  u.outputTokens += r.output_tokens
  u.cacheReadTokens = (u.cacheReadTokens ?? 0) + cacheRead
  u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + cacheWrite
  u.model = model // with a refusal fallback, the model that answered
}
