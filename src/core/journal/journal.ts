// The event journal of one bot: typed facts appended to data/bots/<username>/journal/
// YYYY-MM-DD.jsonl, rolled up per hour/day into journal/rollups/YYYY-MM-DD.json, pruned by
// retention, and queryable from code, chat and LLM tools. Capture (mineflayer + agent events)
// lives in capture.ts; this class is storage, limits, rollups and queries, and works without
// a bot (tests, scripts).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../log.ts'
import { redactSecrets } from '../log.ts'
import type { LlmProvider } from '../../llm/types.ts'
import type { JournalConfig, JournalEvent, Pos } from './types.ts'
import { resolveJournalConfig } from './config.ts'
import { RateLimiter, type Counts } from './aggregate.ts'
import { filterEvents, type JournalQuery } from './query.ts'
import { buildDayRollup, buildSection, type DayRollup, type RollupSection } from './rollup.ts'
import { dayKey, dayStart, daysBetween, nextDay, parseRange, ago, type TimeRange } from './time.ts'
import { fmtP, fmtRollup, fmtSection, fmtCounts } from './format.ts'
import { providerFor, summarizeRollup } from './summary.ts'

/** Ground items despawn after 5 minutes (6000 ticks) in loaded chunks. */
export const ITEM_DESPAWN_MS = 5 * 60_000

export interface JournalOptions {
  /** Directory for the JSONL files (data/bots/<username>/journal). */
  dir: string
  config?: JournalConfig
  settings?: Record<string, unknown>
  log?: Logger
  bot?: string
  now?: () => number
}

export interface DeathView {
  ts: number
  pos?: Pos
  dim?: string
  cause?: string
  killer?: string
  message?: string
  healthBefore?: number
  action?: string
  lost: Counts
  lostCount: number
  keptInventory?: boolean
  /** Died less than 5 minutes ago and didn't keep the inventory: the drops may still be there. */
  itemsMayRemain: boolean
}

export interface PeriodSummary {
  label: string
  range: TimeRange
  section: RollupSection
  summary?: string
  text: string
}

const RAW_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const ROLLUP_RE = /^(\d{4}-\d{2}-\d{2})\.json$/

export class Journal {
  readonly dir: string
  readonly rollupDir: string
  readonly config: JournalConfig
  /** The bot's name, for rollups. */
  readonly botName?: string
  /** Same as botName (older name). */
  get bot (): string | undefined { return this.botName }
  private readonly log?: Logger
  private readonly now: () => number
  private readonly limiter: RateLimiter
  private buffer: JournalEvent[] = []
  private timers: NodeJS.Timeout[] = []
  private lastHour = ''
  private lastDay = ''
  private summarizing = false
  private warnedWrite = false
  private providerOverride: LlmProvider | null = null
  /** Called for every recorded event (after caps), e.g. for live views. */
  private listeners = new Set<(e: JournalEvent) => void>()

  constructor (opts: JournalOptions) {
    this.dir = opts.dir
    this.rollupDir = join(opts.dir, 'rollups')
    this.config = opts.config ?? resolveJournalConfig(opts.settings ?? {})
    this.log = opts.log
    this.botName = opts.bot
    this.now = opts.now ?? Date.now
    this.limiter = new RateLimiter(this.config.caps)
  }

  /** Events waiting for the next flush. */
  get buffered (): number {
    return this.buffer.length
  }

  get enabled (): boolean {
    return this.config.enabled
  }

  wants (type: string): boolean {
    if (!this.config.enabled || this.config.exclude.has(type)) return false
    return !this.config.types || this.config.types.has(type) || type === 'journal_dropped'
  }

  onEvent (fn: (e: JournalEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** For tests and callers that already have a provider: used instead of journal.summarize. */
  setSummaryProvider (p: LlmProvider | null): void {
    this.providerOverride = p
  }

  // ---------------------------------------------------------------- writing

  /**
   * Records an event. Returns false if the type is off or over its per-minute cap. String
   * values in data are run through the log redaction (secrets from the environment).
   */
  record (type: string, data: Record<string, unknown> = {}, extra: { pos?: Pos, dim?: string, ts?: number } = {}): boolean {
    if (!this.wants(type)) return false
    const ts = extra.ts ?? this.now()
    if (!this.limiter.allow(type, ts)) return false
    const e: JournalEvent = {
      ts,
      type,
      ...(extra.pos ? { pos: { x: Math.floor(extra.pos.x), y: Math.floor(extra.pos.y), z: Math.floor(extra.pos.z) } } : {}),
      ...(extra.dim ? { dim: extra.dim } : {}),
      data: scrub(data) as Record<string, unknown>
    }
    this.buffer.push(e)
    for (const l of this.listeners) { try { l(e) } catch {} }
    if (this.buffer.length >= 200) this.flush()
    return true
  }

  /** Writes buffered events (and per-minute drop counts) to their day files. */
  flush (): void {
    for (const [type, count] of this.limiter.takeDropped(this.now())) {
      this.buffer.push({ ts: this.now(), type: 'journal_dropped', data: { type, count } })
    }
    if (!this.buffer.length) return
    const batch = this.buffer
    this.buffer = []
    const byDay = new Map<string, string[]>()
    for (const e of batch) {
      const k = dayKey(e.ts)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k)!.push(JSON.stringify(e))
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const [k, lines] of byDay) appendFileSync(join(this.dir, `${k}.jsonl`), lines.join('\n') + '\n')
    } catch (e) {
      if (!this.warnedWrite) this.log?.warn(`journal write failed: ${(e as Error).message}`, { dir: this.dir })
      this.warnedWrite = true
    }
  }

  /** Starts the flush and hourly rollup timers (idempotent). */
  start (): void {
    if (this.timers.length || !this.config.enabled) return
    const flush = setInterval(() => this.flush(), this.config.flushMs)
    const tick = setInterval(() => this.tick(), 60_000)
    flush.unref(); tick.unref()
    this.timers.push(flush, tick)
    this.lastHour = hourKey(this.now())
    this.lastDay = dayKey(this.now())
    setTimeout(() => this.maintain(), 5000).unref()
  }

  stop (): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.flush()
  }

  /** Every minute: rolls up today when an hour closes, finishes yesterday when a day closes. */
  tick (): void {
    const now = this.now()
    const h = hourKey(now)
    if (h === this.lastHour) return
    this.lastHour = h
    this.flush()
    const d = dayKey(now)
    if (d !== this.lastDay) {
      this.lastDay = d
      this.maintain()
    } else {
      try { this.rollup(d) } catch (e) { this.log?.warn(`hourly rollup failed: ${(e as Error).message}`) }
    }
  }

  // ---------------------------------------------------------------- files

  /** Day keys that have a raw file, oldest first. */
  rawDays (): string[] {
    return listKeys(this.dir, RAW_RE)
  }

  rollupDays (): string[] {
    return listKeys(this.rollupDir, ROLLUP_RE)
  }

  /** Events of one day, including ones still in the write buffer. */
  readDay (date: string): JournalEvent[] {
    const out: JournalEvent[] = []
    const file = join(this.dir, `${date}.jsonl`)
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue
        try { out.push(JSON.parse(line)) } catch {}
      }
    }
    for (const e of this.buffer) if (dayKey(e.ts) === date) out.push(e)
    return out
  }

  readRollup (date: string): DayRollup | null {
    try { return JSON.parse(readFileSync(join(this.rollupDir, `${date}.json`), 'utf8')) } catch { return null }
  }

  /** Builds (and by default writes) the rollup of a day from its raw file. Keeps an existing summary. */
  rollup (date: string, opts: { write?: boolean } = {}): DayRollup {
    const events = this.readDay(date)
    const prev = this.readRollup(date)
    if (!events.length && prev) return prev
    const r = buildDayRollup(events, date, { now: this.now(), bot: this.botName })
    if (prev?.summary) { r.summary = prev.summary; if (prev.summaryBy) r.summaryBy = prev.summaryBy }
    if (opts.write !== false && events.length) this.writeRollup(r)
    return r
  }

  private writeRollup (r: DayRollup): void {
    mkdirSync(this.rollupDir, { recursive: true })
    const file = join(this.rollupDir, `${r.date}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 1) + '\n')
    renameSync(`${file}.tmp`, file)
  }

  /**
   * Finishes past days: writes final rollups for raw files whose rollup is missing or not
   * final, asks for summaries if configured, then applies retention. Runs at start and when a
   * day closes; safe to call any time.
   */
  maintain (): void {
    this.flush()
    const today = dayKey(this.now())
    const finished: string[] = []
    for (const d of this.rawDays()) {
      if (d >= today) continue
      const r = this.readRollup(d)
      const stale = !r || !r.final || r.generatedAt < mtime(join(this.dir, `${d}.jsonl`))
      if (stale) {
        try { this.rollup(d); finished.push(d) } catch (e) { this.log?.warn(`rollup of ${d} failed: ${(e as Error).message}`) }
      }
    }
    if (finished.length) this.log?.debug(`rolled up ${finished.length} day(s)`, { days: finished.join(',') })
    this.applyRetention()
    if (this.config.summarize || this.providerOverride) {
      const pending = this.rollupDays().filter(d => d < today && !this.readRollup(d)?.summary).slice(-3)
      if (pending.length) void this.summarizeDays(pending)
    }
  }

  /** Deletes raw files older than retentionDays that have a final rollup, and old rollups. Returns what was deleted. */
  applyRetention (): { raw: string[], rollups: string[] } {
    const now = this.now()
    const rawCut = dayKey(now - this.config.retentionDays * 86_400_000)
    const rollCut = dayKey(now - this.config.rollupRetentionDays * 86_400_000)
    const raw: string[] = []
    const rollups: string[] = []
    for (const d of this.rawDays()) {
      if (d >= rawCut) continue
      const r = this.readRollup(d)
      if (!r?.final) continue
      try { rmSync(join(this.dir, `${d}.jsonl`)); raw.push(d) } catch {}
    }
    for (const d of this.rollupDays()) {
      if (d >= rollCut) continue
      try { rmSync(join(this.rollupDir, `${d}.json`)); rollups.push(d) } catch {}
    }
    if (raw.length || rollups.length) this.log?.info('journal retention', { raw: raw.length, rollups: rollups.length })
    return { raw, rollups }
  }

  /** Adds an LLM summary to the given days' rollups (journal.summarize or setSummaryProvider). */
  async summarizeDays (days: string[]): Promise<number> {
    if (this.summarizing) return 0
    this.summarizing = true
    let n = 0
    try {
      const provider = this.providerOverride ?? (this.config.summarize ? await providerFor(this.config.summarize) : null)
      if (!provider) return 0
      for (const d of days) {
        const r = this.readRollup(d) ?? this.rollup(d)
        if (!r.totals.events) continue
        try {
          r.summary = await summarizeRollup(r, provider, { maxChars: this.config.summarize?.maxChars })
          r.summaryBy = `${provider.name}${provider.model ? `/${provider.model}` : ''}`
          this.writeRollup(r)
          n++
        } catch (e) {
          this.log?.warn(`journal summary for ${d} failed: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      this.log?.warn(`journal summaries off: ${(e as Error).message}`)
    } finally {
      this.summarizing = false
    }
    return n
  }

  // ---------------------------------------------------------------- queries

  /**
   * Events matching the query, oldest first (newest `limit`, default 50). Reads raw files for
   * the days in range; for days whose raw file is gone, deaths and a day summary come from
   * the rollup (marked fromRollup). Without `since` it looks back 7 days.
   */
  query (q: JournalQuery = {}): JournalEvent[] {
    const now = this.now()
    const range = typeof q.since === 'string' ? parseRange(q.since, now) : null
    const since = typeof q.since === 'number' ? q.since : range?.since ?? now - 7 * 86_400_000
    const until = q.until ?? range?.until ?? now
    const raw = new Set(this.rawDays())
    const rolled = new Set(this.rollupDays())
    const events: JournalEvent[] = []
    const oldest = [this.rawDays()[0], this.rollupDays()[0], dayKey(now)].filter(Boolean).sort()[0]
    const first = Math.max(since, dayStart(oldest))
    for (const d of daysBetween(Math.min(first, until), until)) {
      if (raw.has(d) || this.buffer.some(e => dayKey(e.ts) === d)) events.push(...this.readDay(d))
      else if (rolled.has(d)) events.push(...rollupEvents(this.readRollup(d)))
    }
    return filterEvents(events, { ...q, since, until })
  }

  /** The most recent death, with what was lost and whether the drops may still be there. */
  lastDeath (): DeathView | null {
    const deaths = this.query({ types: ['death', 'respawn'], since: 0, limit: 0 })
    const i = deaths.map(e => e.type).lastIndexOf('death')
    if (i < 0) return null
    const d = deaths[i]
    const respawn = deaths.slice(i + 1).find(e => e.type === 'respawn')
    return toDeathView(d, respawn, this.now())
  }

  deaths (since: number | string = 'all'): DeathView[] {
    const evs = this.query({ types: ['death', 'respawn'], since, limit: 0 })
    const out: DeathView[] = []
    evs.forEach((e, i) => {
      if (e.type !== 'death') return
      const next = evs.slice(i + 1).find(x => x.type === 'death' || x.type === 'respawn')
      out.push(toDeathView(e, next?.type === 'respawn' ? next : undefined, this.now()))
    })
    return out
  }

  /** Where the bot was at a time: the closest event with a position (prefers the last one before). */
  whereWas (time: number | string): { pos: Pos, dim?: string, ts: number, type: string } | null {
    const t = typeof time === 'number' ? time : (Date.parse(time) || parseRange(time, this.now())?.since)
    if (t === undefined || Number.isNaN(t)) return null
    const evs = this.query({ since: t - 6 * 3_600_000, until: t + 6 * 3_600_000, limit: 0 }).filter(e => e.pos)
    let best: JournalEvent | undefined
    for (const e of evs) {
      if (e.ts <= t) best = e
      else { if (!best || e.ts - t < t - best.ts) best = e; break }
    }
    return best ? { pos: best.pos!, dim: best.dim, ts: best.ts, type: best.type } : null
  }

  /**
   * A summary of a period: "today", "yesterday", a date, "1h", "10-12" (hours today). Whole
   * days use (and refresh) the day rollup; other ranges are aggregated on the fly.
   */
  summary (period = 'today'): PeriodSummary | null {
    const now = this.now()
    const range = parseRange(period, now)
    if (!range) return null
    if (/^(today|yesterday|\d{4}-\d{2}-\d{2})$/i.test(period.trim())) {
      const date = dayKey(range.since)
      const r = date === dayKey(now) ? this.rollup(date, { write: false }) : this.readRawOrRollup(date)
      if (!r || !r.totals.events) return { label: range.label, range, section: buildSection([], range.since, range.until), text: `${range.label}: nothing recorded` }
      return { label: range.label, range, section: r.totals, ...(r.summary ? { summary: r.summary } : {}), text: fmtRollup(r, range.label, now) }
    }
    const events = this.query({ since: range.since, until: range.until, limit: 0 })
    const section = buildSection(events, range.since, range.until + 1, { openUntil: Math.min(range.until, now) })
    return { label: range.label, range, section, text: fmtSection(section, range.label, now) }
  }

  private readRawOrRollup (date: string): DayRollup | null {
    if (existsSync(join(this.dir, `${date}.jsonl`))) return this.rollup(date)
    return this.readRollup(date)
  }

  /** One line of recent notable events for observe(), or null if nothing notable. */
  notableLine (): string | null {
    const now = this.now()
    const parts: string[] = []
    const d = this.lastDeath()
    if (d && now - d.ts < 24 * 3_600_000) {
      parts.push(`died ${ago(d.ts, now)} at ${fmtP(d.pos)}${d.dim && !/overworld/.test(d.dim) ? ` (${d.dim})` : ''}: ${d.message ?? d.cause ?? 'unknown cause'}` +
        (d.lostCount ? `, lost ${fmtCounts(d.lost, 3)}${d.itemsMayRemain ? ' (drops may still be there)' : ''}` : ''))
    }
    const recent = this.query({ types: ['disconnect', 'kill', 'advancement'], since: now - 3_600_000, limit: 3 })
    for (const e of recent.reverse()) {
      if (e.type === 'disconnect' && e.data.reason && !/quit|stop/i.test(String(e.data.reason))) parts.push(`disconnected ${ago(e.ts, now)} (${String(e.data.reason).slice(0, 60)})`)
      if (e.type === 'kill') parts.push(`killed ${e.data.entity} ${ago(e.ts, now)}`)
      if (e.type === 'advancement' && e.data.self !== false) parts.push(`advancement [${e.data.advancement}] ${ago(e.ts, now)}`)
    }
    return parts.length ? parts.slice(0, 3).join('; ') : null
  }
}

function toDeathView (d: JournalEvent, respawn: JournalEvent | undefined, now: number): DeathView {
  const lost = (d.data.lost ?? {}) as Counts
  const kept = respawn?.data.keptInventory === true
  return {
    ts: d.ts,
    ...(d.pos ? { pos: d.pos } : {}),
    ...(d.dim ? { dim: d.dim } : {}),
    ...(d.data.cause ? { cause: d.data.cause } : {}),
    ...(d.data.killer ? { killer: d.data.killer } : {}),
    ...(d.data.message ? { message: d.data.message } : {}),
    ...(d.data.healthBefore !== undefined ? { healthBefore: d.data.healthBefore } : {}),
    ...(d.data.action ? { action: d.data.action } : {}),
    lost,
    lostCount: Object.values(lost).reduce((a, b) => a + Number(b), 0),
    ...(respawn ? { keptInventory: kept } : {}),
    itemsMayRemain: now - d.ts < ITEM_DESPAWN_MS && !kept && Object.keys(lost).length > 0
  }
}

/** Events reconstructed from a rollup: its deaths, plus one 'rollup' event for the day. */
export function rollupEvents (r: DayRollup | null): JournalEvent[] {
  if (!r) return []
  const out: JournalEvent[] = r.totals.deaths.map(d => ({
    ts: d.ts, type: 'death', ...(d.pos ? { pos: d.pos } : {}), ...(d.dim ? { dim: d.dim } : {}),
    data: { cause: d.cause, killer: d.killer, message: d.message, lost: d.lost ?? {}, lostCount: Object.values(d.lost ?? {}).reduce((a, b) => a + b, 0), action: d.action },
    fromRollup: true
  }))
  out.push({ ts: r.totals.from, type: 'rollup', data: { date: r.date, text: r.summary ?? fmtSection(r.totals, r.date) }, fromRollup: true })
  return out
}

function listKeys (dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).map(f => re.exec(f)?.[1]).filter((x): x is string => !!x).sort()
  } catch {
    return []
  }
}

function mtime (file: string): number {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

function hourKey (ts: number): string {
  return `${dayKey(ts)}T${new Date(ts).getHours()}`
}

/** Redacts secrets in string values (recursively), drops undefined. */
function scrub (v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactSecrets(v)
  if (depth > 4 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = scrub(x, depth + 1)
  return out
}
