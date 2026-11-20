// Spend guardrails over the usage counters: a sliding one-hour window (in memory) and the
// calendar day (from the persisted daily bucket, so restarts don't reset it). Dollars only
// count real API spend; subscription turns are limited by turns and tokens.
import type { TurnUsage, UsageTotals } from './usage.ts'

export interface BudgetOptions {
  /** Max LLM turns per hour (0 = unlimited). Default 60. */
  turnsPerHour?: number
  /** Max input+output tokens per hour (0 = unlimited). Default 400k. */
  tokensPerHour?: number
  /** Max estimated API USD per hour (0 = unlimited). Default 1. */
  usdPerHour?: number
  /** Max input+output tokens per calendar day (0 = unlimited). Default 0. */
  tokensPerDay?: number
  /** Max estimated API USD per calendar day (0 = unlimited). Default 5. */
  usdPerDay?: number
}

interface Entry { at: number, tokens: number, usd: number }

const HOUR = 3_600_000

export class Budget {
  readonly turnsPerHour: number
  readonly tokensPerHour: number
  readonly usdPerHour: number
  readonly tokensPerDay: number
  readonly usdPerDay: number
  private entries: Entry[] = []
  private readonly now: () => number
  private readonly today: () => UsageTotals | undefined

  constructor (opts: BudgetOptions = {}, deps: { now?: () => number, today?: () => UsageTotals | undefined } = {}) {
    this.turnsPerHour = opts.turnsPerHour ?? 60
    this.tokensPerHour = opts.tokensPerHour ?? 400_000
    this.usdPerHour = opts.usdPerHour ?? 1
    this.tokensPerDay = opts.tokensPerDay ?? 0
    this.usdPerDay = opts.usdPerDay ?? 5
    this.now = deps.now ?? Date.now
    this.today = deps.today ?? (() => undefined)
  }

  private prune (): void {
    const cutoff = this.now() - HOUR
    while (this.entries.length && this.entries[0]!.at < cutoff) this.entries.shift()
  }

  /** Returns null if another turn is allowed, otherwise why not. */
  blocked (): string | null {
    const h = this.hour()
    if (this.turnsPerHour > 0 && h.turns >= this.turnsPerHour) return `turn budget used (${h.turns}/${this.turnsPerHour} this hour)`
    if (this.tokensPerHour > 0 && h.tokens >= this.tokensPerHour) return `token budget used (${h.tokens}/${this.tokensPerHour} this hour)`
    if (this.usdPerHour > 0 && h.usd >= this.usdPerHour) return `cost budget used ($${h.usd.toFixed(3)}/$${this.usdPerHour} this hour)`
    const d = this.today()
    if (d) {
      const tokens = d.inputTokens + d.outputTokens
      if (this.tokensPerDay > 0 && tokens >= this.tokensPerDay) return `daily token budget used (${tokens}/${this.tokensPerDay})`
      if (this.usdPerDay > 0 && d.costUsd >= this.usdPerDay) return `daily cost budget used ($${d.costUsd.toFixed(3)}/$${this.usdPerDay})`
    }
    return null
  }

  /** Records one finished (or failed) turn. */
  record (u?: Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'costUsd'>): void {
    this.entries.push({
      at: this.now(),
      tokens: u ? u.inputTokens + u.outputTokens : 0,
      usd: u?.costUsd ?? 0
    })
  }

  /** Usage in the last hour. */
  hour (): { turns: number, tokens: number, usd: number } {
    this.prune()
    return this.entries.reduce((a, e) => ({ turns: a.turns + 1, tokens: a.tokens + e.tokens, usd: a.usd + e.usd }), { turns: 0, tokens: 0, usd: 0 })
  }
}
