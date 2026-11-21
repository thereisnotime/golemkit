// Day keys and human time ranges. Days are local time (the bot host's timezone), so "today"
// and the file names agree with the person reading them.

const pad = (n: number) => String(n).padStart(2, '0')

/** Local date of a timestamp as YYYY-MM-DD. */
export function dayKey (ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight of a YYYY-MM-DD key. */
export function dayStart (key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

export function nextDay (key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + 1).getTime())
}

export function hourOf (ts: number): number {
  return new Date(ts).getHours()
}

/** Every day key from since to until (inclusive), oldest first. */
export function daysBetween (since: number, until: number): string[] {
  const out: string[] = []
  let k = dayKey(since)
  const last = dayKey(until)
  for (let i = 0; i < 4000; i++) {
    out.push(k)
    if (k === last) break
    k = nextDay(k)
  }
  return out
}

export interface TimeRange { since: number, until: number, label: string }

const UNIT: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }

/**
 * Parses "1h", "30m", "2d", "today", "yesterday", "YYYY-MM-DD", "10:00-12:00" (today),
 * "HH-HH" hour ranges, an ISO time or epoch ms into a range ending now (or at the end of
 * that day / hour range). Returns null when it can't make sense of it.
 */
export function parseRange (spec: string | number | undefined, now = Date.now()): TimeRange | null {
  if (spec === undefined || spec === '') return null
  if (typeof spec === 'number') return { since: spec, until: now, label: new Date(spec).toISOString() }
  const s = spec.trim().toLowerCase()
  const today = dayKey(now)
  if (s === 'today') return { since: dayStart(today), until: now, label: 'today' }
  if (s === 'yesterday') {
    const start = dayStart(today) - 86_400_000 / 2
    const key = dayKey(start)
    return { since: dayStart(key), until: dayStart(today) - 1, label: 'yesterday' }
  }
  if (s === 'all' || s === 'ever') return { since: 0, until: now, label: 'all time' }
  let m = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$/.exec(s)
  if (m) return { since: now - Number(m[1]) * UNIT[m[2]], until: now, label: `last ${m[1]}${m[2]}` }
  m = /^(\d{4}-\d{2}-\d{2})$/.exec(s)
  if (m) return { since: dayStart(m[1]), until: Math.min(now, dayStart(nextDay(m[1])) - 1), label: m[1] }
  // hour ranges today: "10-12", "10:00-12:30", optionally "yesterday 10-12"
  m = /^(yesterday\s+)?(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(s)
  if (m) {
    const base = m[1] ? dayStart(dayKey(dayStart(today) - 43_200_000)) : dayStart(today)
    const a = base + Number(m[2]) * 3_600_000 + Number(m[3] ?? 0) * 60_000
    const b = base + Number(m[4]) * 3_600_000 + Number(m[5] ?? 0) * 60_000
    if (b <= a) return null
    return { since: a, until: Math.min(b, now), label: `${m[1] ? 'yesterday ' : ''}${m[2]}:${m[3] ?? '00'}-${m[4]}:${m[5] ?? '00'}` }
  }
  const t = Date.parse(spec)
  if (!Number.isNaN(t)) return { since: t, until: now, label: spec }
  return null
}

/** "12m ago", "3h ago", "2d ago". */
export function ago (ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Local HH:MM. */
export function clock (ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
