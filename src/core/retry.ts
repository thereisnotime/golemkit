// Retry policies: failed actions, transient LLM errors, reconnects.
//
// Layers (later wins): env defaults < variant settings.retry < profile `retry:` < fleet entry.
//
//   retry:
//     actions: { "*": 0, goto: 2, chop_tree: 1 }   # extra attempts after a failed result
//     actionBackoffMs: [1000, 8000]                # first wait, max wait (doubles, with jitter)
//     llm: { attempts: 2, backoffMs: [2000, 20000] }   # transient provider errors only
//     reconnect: { baseMs: 10000, maxMs: 300000 }  # exponential while the server is unreachable
//
// env: MC_RETRY_ACTIONS="*=0,goto=2"  MC_RETRY_LLM=2  MC_RECONNECT_MAX_MS=300000

export interface RetryConfig {
  actions: Record<string, number>
  actionBackoffMs: [number, number]
  llm: { attempts: number, backoffMs: [number, number] }
  reconnect: { baseMs: number, maxMs: number }
}

export const RETRY_DEFAULTS: RetryConfig = {
  actions: { '*': 0 },
  actionBackoffMs: [1000, 8000],
  llm: { attempts: 2, backoffMs: [2000, 20_000] },
  reconnect: { baseMs: 10_000, maxMs: 300_000 }
}

function parseActionList (v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (v ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [k, n] = part.split('=')
    if (k && n !== undefined && !Number.isNaN(Number(n))) out[k.trim()] = Number(n)
  }
  return out
}

export function retryFromEnv (env: NodeJS.ProcessEnv = process.env): Partial<RetryConfig> {
  const out: Partial<RetryConfig> = {}
  const actions = parseActionList(env.MC_RETRY_ACTIONS)
  if (Object.keys(actions).length) out.actions = actions
  if (env.MC_RETRY_LLM) out.llm = { ...RETRY_DEFAULTS.llm, attempts: Number(env.MC_RETRY_LLM) }
  const base = env.MC_RECONNECT_DELAY_MS ? Number(env.MC_RECONNECT_DELAY_MS) : undefined
  const max = env.MC_RECONNECT_MAX_MS ? Number(env.MC_RECONNECT_MAX_MS) : undefined
  if (base || max) out.reconnect = { baseMs: base ?? RETRY_DEFAULTS.reconnect.baseMs, maxMs: max ?? RETRY_DEFAULTS.reconnect.maxMs }
  return out
}

/** Merges env defaults with settings.retry (one level deep; `actions` maps merge by key). */
export function resolveRetry (settings: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): RetryConfig {
  const fromEnv = retryFromEnv(env)
  const s = (settings.retry ?? {}) as Partial<RetryConfig> & { llm?: Partial<RetryConfig['llm']>, reconnect?: Partial<RetryConfig['reconnect']> }
  return {
    actions: { ...RETRY_DEFAULTS.actions, ...fromEnv.actions, ...s.actions },
    actionBackoffMs: s.actionBackoffMs ?? fromEnv.actionBackoffMs ?? RETRY_DEFAULTS.actionBackoffMs,
    llm: { ...RETRY_DEFAULTS.llm, ...fromEnv.llm, ...s.llm },
    reconnect: { ...RETRY_DEFAULTS.reconnect, ...fromEnv.reconnect, ...s.reconnect }
  }
}

/** Extra attempts for an action (exact name first, then "*"). */
export function actionAttempts (cfg: RetryConfig, action: string): number {
  return Math.max(0, cfg.actions[action] ?? cfg.actions['*'] ?? 0)
}

/** Exponential backoff with ±25% jitter: base, 2·base, 4·base ... capped at max. */
export function backoffMs (attempt: number, [base, max]: [number, number], rnd: () => number = Math.random): number {
  const raw = Math.min(max, base * 2 ** attempt)
  return Math.round(raw * (0.75 + rnd() * 0.5))
}

/** Results that retrying can't fix (or that someone else caused on purpose). */
const NOT_RETRYABLE = /^(busy|unknown action|bad parameters|not connected|stopped|replaced|preempted|session ended|died|cancelled|digging is disabled|nothing to|no )/i

export function isRetryableResult (message: string): boolean {
  return !NOT_RETRYABLE.test(message.trim())
}

/** Provider errors worth another try: timeouts, rate limits, overload, 5xx, network blips. */
export function isTransientLlmError (message: string): boolean {
  if (/abort|not logged in|auth|unauthori[sz]ed|forbidden|invalid api key|budget/i.test(message)) return false
  return /timed? ?out|timeout|429|rate.?limit|overload|5\d\d|ECONN|EPIPE|socket|network|fetch failed|temporarily|unavailable/i.test(message)
}
