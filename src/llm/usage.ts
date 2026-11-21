// Token and cost accounting for LLM brains: per turn, per bot (since start, today, all
// time, persisted in agent.storage as daily buckets), per provider, and fleet-wide for the
// bots in this process.
import type { Storage } from '../core/index.ts'
import type { Usage } from './types.ts'

/**
 * How a provider is paid for. api: per token, dollars are real. subscription: flat plan
 * (Claude Pro/Max, ChatGPT), tokens count against plan limits, not dollars. local: your own
 * hardware or an endpoint without a known price.
 */
export type Billing = 'api' | 'subscription' | 'local'

/** One finished turn. */
export interface TurnUsage {
  at: number
  provider: string
  model?: string
  billing: Billing
  /** All input tokens, cached ones included. */
  inputTokens: number
  outputTokens: number
  /** Subsets of inputTokens. */
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  durationMs: number
  /** Real spend estimate (api billing only). */
  costUsd?: number
  /** A cost the CLI reported for a subscription turn (Claude Code's list-price estimate). Not money spent. */
  reportedCostUsd?: number
  /** Token numbers estimated from text length because the provider reported none. */
  estimated: boolean
  ok: boolean
  /** What started the turn ("whisper from robin", "goal: actionDone", "event: death"...). */
  trigger?: string
  /** Proxy counters that changed during this turn (caveman /metrics), when a proxy is used. */
  proxy?: Record<string, number>
}

export interface UsageTotals {
  turns: number
  failedTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  durationMs: number
  costUsd: number
  reportedCostUsd: number
  estimatedTurns: number
}

export interface UsageBucket extends UsageTotals {
  byProvider: Record<string, UsageTotals>
}

export interface UsageSnapshot {
  username: string
  provider: string
  billing: Billing
  last?: TurnUsage
  session: UsageBucket
  today: UsageBucket
  allTime: UsageBucket
}

export const emptyTotals = (): UsageTotals => ({
  turns: 0, failedTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  toolCalls: 0, durationMs: 0, costUsd: 0, reportedCostUsd: 0, estimatedTurns: 0
})
const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof UsageTotals)[]
const emptyBucket = (): UsageBucket => ({ ...emptyTotals(), byProvider: {} })

export function addTurn (t: UsageTotals, u: TurnUsage): void {
  t.turns++
  if (!u.ok) t.failedTurns++
  t.inputTokens += u.inputTokens
  t.outputTokens += u.outputTokens
  t.cacheReadTokens += u.cacheReadTokens
  t.cacheWriteTokens += u.cacheWriteTokens
  t.toolCalls += u.toolCalls
  t.durationMs += u.durationMs
  t.costUsd += u.costUsd ?? 0
  t.reportedCostUsd += u.reportedCostUsd ?? 0
  if (u.estimated) t.estimatedTurns++
}

function addToBucket (b: UsageBucket, u: TurnUsage): void {
  addTurn(b, u)
  addTurn(b.byProvider[u.provider] ??= emptyTotals(), u)
}

export function sumBuckets (list: UsageBucket[]): UsageBucket {
  const out = emptyBucket()
  for (const b of list) {
    mergeTotals(out, b)
    for (const [p, t] of Object.entries(b.byProvider)) mergeTotals(out.byProvider[p] ??= emptyTotals(), t)
  }
  return out
}

function mergeTotals (into: UsageTotals, t: UsageTotals): void {
  for (const k of TOTAL_KEYS) into[k] += t[k] ?? 0
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey (at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const STORE_KEY = 'llm.usage'
interface Stored { days: Record<string, UsageBucket>, allTime: UsageBucket }

const fleet = new Set<UsageTracker>()

export class UsageTracker {
  readonly username: string
  readonly session: UsageBucket = emptyBucket()
  last?: TurnUsage
  private readonly storage: Storage
  private readonly keepDays: number
  private readonly now: () => number

  constructor (username: string, storage: Storage, opts: { keepDays?: number, now?: () => number } = {}) {
    this.username = username
    this.storage = storage
    this.keepDays = opts.keepDays ?? 90
    this.now = opts.now ?? Date.now
    fleet.add(this)
  }

  dispose (): void {
    fleet.delete(this)
  }

  private load (): Stored {
    const s = this.storage.get<Stored>(STORE_KEY)
    return { days: s?.days ?? {}, allTime: s?.allTime ?? emptyBucket() }
  }

  record (u: TurnUsage): void {
    this.last = u
    addToBucket(this.session, u)
    const s = this.load()
    addToBucket(s.days[dayKey(u.at)] ??= emptyBucket(), u)
    addToBucket(s.allTime, u)
    const keys = Object.keys(s.days).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - this.keepDays))) delete s.days[k]
    this.storage.set(STORE_KEY, s)
  }

  get today (): UsageBucket {
    return this.load().days[dayKey(this.now())] ?? emptyBucket()
  }

  get allTime (): UsageBucket {
    return this.load().allTime
  }

  /** Daily buckets, oldest first. */
  days (): [string, UsageBucket][] {
    return Object.entries(this.load().days).sort(([a], [b]) => a.localeCompare(b))
  }

  snapshot (provider: string, billing: Billing): UsageSnapshot {
    return { username: this.username, provider, billing, last: this.last, session: this.session, today: this.today, allTime: this.allTime }
  }
}

/** Totals over every LLM bot in this process (a fleet run). */
export function fleetUsage (): { bots: number, session: UsageBucket, today: UsageBucket, allTime: UsageBucket } {
  const list = [...fleet]
  return {
    bots: list.length,
    session: sumBuckets(list.map(t => t.session)),
    today: sumBuckets(list.map(t => t.today)),
    allTime: sumBuckets(list.map(t => t.allTime))
  }
}

// ------------------------------------------------------------------ formatting

export function fmtTokens (n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function fmtUsd (n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`
}

/** Cost part of a summary: dollars for API spend, "subscription" for plans (with the CLI's own estimate if it gave one). */
export function fmtCost (t: { costUsd?: number, reportedCostUsd?: number }, billing: Billing): string {
  if (billing === 'api') return `~${fmtUsd(t.costUsd ?? 0)}`
  if (billing === 'subscription') return t.reportedCostUsd ? `subscription (CLI est. ${fmtUsd(t.reportedCostUsd)})` : 'subscription'
  return t.costUsd ? `~${fmtUsd(t.costUsd)}` : 'local'
}

/** `llm turn: 1.2k in / 180 out / 900 cached, 3 tools, 4.1s, ~$0.004` */
export function fmtTurn (u: TurnUsage): string {
  const est = u.estimated ? ' (estimated)' : ''
  return `${fmtTokens(u.inputTokens)} in / ${fmtTokens(u.outputTokens)} out / ${fmtTokens(u.cacheReadTokens)} cached${est}, ` +
    `${u.toolCalls} tool${u.toolCalls === 1 ? '' : 's'}, ${(u.durationMs / 1000).toFixed(1)}s, ${fmtCost(u, u.billing)}`
}

export function fmtTotals (t: UsageTotals, billing: Billing): string {
  return `${t.turns} turns, ${fmtTokens(t.inputTokens)} in / ${fmtTokens(t.outputTokens)} out, ${fmtCost(t, billing)}` +
    (t.estimatedTurns ? ` (${t.estimatedTurns} estimated)` : '')
}

/** One chat line for !llm_usage. */
export function fmtSummary (s: UsageSnapshot): string {
  return `LLM ${s.provider}: today ${fmtTotals(s.today, s.billing)}; since start ${fmtTotals(s.session, s.billing)}; all time ${fmtTotals(s.allTime, s.billing)}`
}

// ------------------------------------------------------------------ estimation

/** Rough token count for providers that report nothing: ~4 characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Fills a TurnUsage from provider-reported usage, or estimates it from the text that went in and out. */
export function turnUsage (args: {
  provider: string
  model?: string
  billing: Billing
  reported?: Usage
  /** For estimation when nothing was reported. */
  inText: string
  outText: string
  toolCalls: number
  durationMs: number
  ok: boolean
  price?: (u: Usage, model?: string) => number | undefined
  at?: number
}): TurnUsage {
  const r = args.reported
  const hasNumbers = !!r && (r.inputTokens > 0 || r.outputTokens > 0)
  const inputTokens = hasNumbers ? r!.inputTokens : estimateTokens(args.inText)
  const outputTokens = hasNumbers ? r!.outputTokens : estimateTokens(args.outText)
  const u: TurnUsage = {
    at: args.at ?? Date.now(),
    provider: args.provider,
    model: r?.model ?? args.model,
    billing: args.billing,
    inputTokens,
    outputTokens,
    cacheReadTokens: hasNumbers ? r!.cacheReadTokens ?? 0 : 0,
    cacheWriteTokens: hasNumbers ? r!.cacheWriteTokens ?? 0 : 0,
    toolCalls: args.toolCalls,
    durationMs: args.durationMs,
    estimated: !hasNumbers,
    ok: args.ok
  }
  if (args.billing === 'subscription') {
    if (r?.costUsd) u.reportedCostUsd = r.costUsd
  } else {
    const cost = r?.costUsd ?? args.price?.({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens }, u.model)
    if (cost !== undefined) u.costUsd = cost
  }
  return u
}
