// USD per million tokens, for estimating API spend. Claude prices are first-party API list
// prices (claude-api skill, cached 2026-11-03). Override or extend with the `prices` option
// or MC_LLM_PRICES='{"model-id":[input, output, cacheRead?, cacheWrite?]}' (e.g. for
// OpenRouter models). Unknown models get no dollar estimate.
import type { Usage } from './types.ts'

/** [input, output, cacheRead, cacheWrite] per million tokens. Missing cache prices default to 0.1x / 1.25x input. */
export type Price = [number, number, number?, number?]

export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], // prompts up to 100k tokens
  'claude-haiku-4-5': [1, 5]
}

export class PriceTable {
  private readonly prices: Record<string, Price>

  constructor (overrides: Record<string, Price> = {}, env: NodeJS.ProcessEnv = process.env) {
    let fromEnv: Record<string, Price> = {}
    if (env.MC_LLM_PRICES) {
      try { fromEnv = JSON.parse(env.MC_LLM_PRICES) } catch { throw new Error('MC_LLM_PRICES must be JSON: {"model":[input,output,cacheRead?,cacheWrite?]}') }
    }
    this.prices = { ...DEFAULT_PRICES, ...fromEnv, ...overrides }
  }

  /** Exact id first, then the longest known prefix (dated or suffixed ids). */
  lookup (model: string | undefined): Price | undefined {
    if (!model) return undefined
    if (this.prices[model]) return this.prices[model]
    const key = Object.keys(this.prices).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    return key ? this.prices[key] : undefined
  }

  /** Estimated USD for a usage record; undefined when the model has no price. */
  cost (u: Usage, model?: string): number | undefined {
    const p = this.lookup(model ?? u.model)
    if (!p) return undefined
    const [inP, outP, readP = inP * 0.1, writeP = inP * 1.25] = p
    const read = u.cacheReadTokens ?? 0
    const write = u.cacheWriteTokens ?? 0
    const fresh = Math.max(0, u.inputTokens - read - write)
    return (fresh * inP + read * readP + write * writeP + u.outputTokens * outP) / 1e6
  }
}
