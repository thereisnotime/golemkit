// Per-turn metrics from an LLM proxy (caveman or any gateway with a Prometheus /metrics page).
// After each turn the runtime scrapes /metrics and keeps the counters that changed since the
// previous scrape, so the journal can show what the proxy did for that turn (requests, tokens
// saved, cache hits... whatever it exports). Best effort: a missing or slow page just gives nothing.

export type MetricDelta = Record<string, number>

/** Parses Prometheus text format into name{labels} -> value. Comments and NaN are skipped. */
export function parsePrometheus (text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+(-?[0-9.eE+-]+|NaN|\+Inf|-Inf)(?:\s+\d+)?$/.exec(line)
    if (!m) continue
    const v = Number(m[2])
    if (Number.isFinite(v)) out[m[1]!] = v
  }
  return out
}

/** Counters that went up (and gauges that changed) between two scrapes; at most `max` entries. */
export function metricDelta (before: Record<string, number>, after: Record<string, number>, max = 24): MetricDelta {
  const out: MetricDelta = {}
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0)
    if (d !== 0 && Object.keys(out).length < max) out[k] = Math.round(d * 1000) / 1000
  }
  return out
}

export class ProxyMetrics {
  private last: Record<string, number> | null = null
  readonly url: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch
  constructor (url: string, timeoutMs = 1500, fetcher: typeof fetch = fetch) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.fetcher = fetcher
  }

  /** The metrics page for a proxy base URL ("http://127.0.0.1:8787/v1" -> ".../metrics"). */
  static forBase (baseUrl: string): ProxyMetrics {
    const u = new URL(baseUrl)
    return new ProxyMetrics(`${u.origin}/metrics`)
  }

  private async scrape (): Promise<Record<string, number> | null> {
    try {
      const res = await this.fetcher(this.url, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) return null
      return parsePrometheus(await res.text())
    } catch { return null }
  }

  /** Call once at start (baseline), then after each turn: what changed since the previous call. */
  async delta (): Promise<MetricDelta | undefined> {
    const now = await this.scrape()
    if (!now) return undefined
    const prev = this.last
    this.last = now
    return prev ? metricDelta(prev, now) : undefined
  }
}
