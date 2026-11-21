// Deterministic rollups: the same events always give the same JSON. A day rollup has totals
// for the day plus one section per hour that had events. Rollups keep deaths in full, so
// "where did I die last week" still works after the raw files are gone.
import type { JournalEvent, Pos } from './types.ts'
import { dayStart, nextDay, hourOf } from './time.ts'
import type { Counts } from './aggregate.ts'

export interface PlaceCluster { x: number, y: number, z: number, dim?: string, count: number, name?: string, first: number, last: number }
export interface DeathRecord { ts: number, pos?: Pos, dim?: string, cause?: string, killer?: string, message?: string, lost?: Counts, action?: string }

export interface RollupSection {
  from: number
  to: number
  events: number
  counts: Counts
  deaths: DeathRecord[]
  kills: Counts
  damage: { taken: number, bySource: Counts }
  items: { gained: Counts, lost: Counts, net: Counts }
  blocks: { broken: Counts, placed: Counts }
  places: PlaceCluster[]
  players: string[]
  advancements: string[]
  chat: { in: number, out: number, whispers: number }
  actions: { total: number, ok: number, failed: number, byName: Record<string, { ok: number, failed: number }>, topFailures: { action: string, message: string, count: number }[] }
  onlineMs: number
  llm: { turns: number, inputTokens: number, outputTokens: number }
}

export interface DayRollup {
  date: string
  bot?: string
  /** The day is over and the rollup won't change. */
  final: boolean
  generatedAt: number
  totals: RollupSection
  /** Keyed "HH:00" (local), only hours with events or online time. */
  hours: Record<string, RollupSection>
  summary?: string
  summaryBy?: string
}

const add = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n }
/** Code-point order, so rollups don't depend on the host locale. */
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const sortCounts = (c: Counts): Counts => Object.fromEntries(Object.entries(c).sort(([a], [b]) => cmp(a, b)))

/** Greedy clustering of positions: each point joins the first cluster within `radius` (same dimension). */
export function clusterPlaces (points: { pos: Pos, dim?: string, ts: number, name?: string }[], radius = 48): PlaceCluster[] {
  const clusters: (PlaceCluster & { sx: number, sy: number, sz: number })[] = []
  for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
    const c = clusters.find(c => c.dim === p.dim && Math.hypot(c.x - p.pos.x, c.z - p.pos.z) <= radius)
    if (c) {
      c.count++; c.sx += p.pos.x; c.sy += p.pos.y; c.sz += p.pos.z
      c.x = Math.round(c.sx / c.count); c.y = Math.round(c.sy / c.count); c.z = Math.round(c.sz / c.count)
      c.last = p.ts
      if (p.name && !c.name) c.name = p.name
    } else {
      clusters.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, ...(p.dim ? { dim: p.dim } : {}), count: 1, ...(p.name ? { name: p.name } : {}), first: p.ts, last: p.ts, sx: p.pos.x, sy: p.pos.y, sz: p.pos.z })
    }
  }
  return clusters
    .map(({ sx: _x, sy: _y, sz: _z, ...c }) => c)
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, 20)
}

/**
 * Online time inside [from, to) from connect/disconnect events. A day that starts with a
 * disconnect was online since `from`; a session still open at the end runs to `openUntil`
 * (the last event, or now for today).
 */
export function onlineMs (events: JournalEvent[], from: number, to: number, openUntil: number, onlineAtStart?: boolean): number {
  const marks = events.filter(e => e.type === 'connect' || e.type === 'disconnect').sort((a, b) => a.ts - b.ts)
  let online = onlineAtStart ?? (marks[0]?.type === 'disconnect')
  let since = from
  let total = 0
  for (const m of marks) {
    if (m.ts < from || m.ts >= to) continue
    if (m.type === 'connect' && !online) { online = true; since = m.ts }
    else if (m.type === 'disconnect' && online) { total += m.ts - since; online = false }
  }
  if (online) total += Math.max(0, Math.min(to, openUntil) - since)
  return total
}

export function buildSection (events: JournalEvent[], from: number, to: number, opts: { openUntil?: number, onlineAtStart?: boolean } = {}): RollupSection {
  const evs = events.filter(e => e.ts >= from && e.ts < to).sort((a, b) => a.ts - b.ts)
  const s: RollupSection = {
    from, to, events: evs.length, counts: {}, deaths: [], kills: {}, damage: { taken: 0, bySource: {} },
    items: { gained: {}, lost: {}, net: {} }, blocks: { broken: {}, placed: {} }, places: [], players: [], advancements: [],
    chat: { in: 0, out: 0, whispers: 0 },
    actions: { total: 0, ok: 0, failed: 0, byName: {}, topFailures: [] },
    onlineMs: 0, llm: { turns: 0, inputTokens: 0, outputTokens: 0 }
  }
  const players = new Set<string>()
  const placePoints: { pos: Pos, dim?: string, ts: number, name?: string }[] = []
  const failures = new Map<string, { action: string, message: string, count: number }>()
  for (const e of evs) {
    add(s.counts, e.type)
    const d = e.data ?? {}
    switch (e.type) {
      case 'death':
        s.deaths.push({ ts: e.ts, ...(e.pos ? { pos: e.pos } : {}), ...(e.dim ? { dim: e.dim } : {}), ...(d.cause ? { cause: d.cause } : {}), ...(d.killer ? { killer: d.killer } : {}), ...(d.message ? { message: d.message } : {}), ...(d.lost && Object.keys(d.lost).length ? { lost: d.lost } : {}), ...(d.action ? { action: d.action } : {}) })
        if (e.pos) placePoints.push({ pos: e.pos, dim: e.dim, ts: e.ts })
        break
      case 'kill': add(s.kills, String(d.entity ?? 'unknown')); break
      case 'damage':
        s.damage.taken += Number(d.amount) || 0
        add(s.damage.bySource, String(d.source ?? 'unknown'), Number(d.amount) || 0)
        break
      case 'item_gained': for (const [k, n] of Object.entries(d.items ?? {})) add(s.items.gained, k, Number(n)); break
      case 'item_lost': for (const [k, n] of Object.entries(d.items ?? {})) add(s.items.lost, k, Number(n)); break
      case 'block_broken': for (const [k, n] of Object.entries(d.blocks ?? {})) add(s.blocks.broken, k, Number(n)); if (e.pos) placePoints.push({ pos: e.pos, dim: e.dim, ts: e.ts }); break
      case 'block_placed': for (const [k, n] of Object.entries(d.blocks ?? {})) add(s.blocks.placed, k, Number(n)); if (e.pos) placePoints.push({ pos: e.pos, dim: e.dim, ts: e.ts }); break
      case 'place_visited': if (e.pos) placePoints.push({ pos: e.pos, dim: e.dim, ts: e.ts, ...(d.place ? { name: d.place } : {}) }); break
      case 'player_seen': case 'player_joined': case 'player_left': if (d.player) players.add(d.player); break
      case 'chat_in': s.chat.in++; if (d.from) players.add(d.from); break
      case 'chat_out': s.chat.out++; break
      case 'whisper': s.chat.whispers++; if (d.from) players.add(d.from); break
      case 'advancement': if (d.advancement) s.advancements.push(d.player && d.self === false ? `${d.player}: ${d.advancement}` : d.advancement); break
      case 'action': {
        const name = String(d.name ?? '?')
        const r = s.actions.byName[name] ??= { ok: 0, failed: 0 }
        s.actions.total++
        if (d.ok) { s.actions.ok++; r.ok++ } else {
          s.actions.failed++; r.failed++
          const msg = String(d.message ?? '').slice(0, 80)
          const key = `${name}|${msg}`
          const f = failures.get(key) ?? { action: name, message: msg, count: 0 }
          f.count++
          failures.set(key, f)
        }
        break
      }
      case 'llm_turn':
        s.llm.turns++
        s.llm.inputTokens += Number(d.inputTokens) || 0
        s.llm.outputTokens += Number(d.outputTokens) || 0
        break
    }
  }
  for (const [k, n] of Object.entries(s.items.gained)) s.items.net[k] = n
  for (const [k, n] of Object.entries(s.items.lost)) s.items.net[k] = (s.items.net[k] ?? 0) - n
  for (const k of Object.keys(s.items.net)) if (s.items.net[k] === 0) delete s.items.net[k]
  s.counts = sortCounts(s.counts)
  s.kills = sortCounts(s.kills)
  s.damage.taken = Math.round(s.damage.taken * 10) / 10
  for (const k of Object.keys(s.damage.bySource)) s.damage.bySource[k] = Math.round(s.damage.bySource[k] * 10) / 10
  s.damage.bySource = sortCounts(s.damage.bySource)
  s.items.gained = sortCounts(s.items.gained)
  s.items.lost = sortCounts(s.items.lost)
  s.items.net = sortCounts(s.items.net)
  s.blocks.broken = sortCounts(s.blocks.broken)
  s.blocks.placed = sortCounts(s.blocks.placed)
  s.actions.byName = Object.fromEntries(Object.entries(s.actions.byName).sort(([a], [b]) => cmp(a, b)))
  s.actions.topFailures = [...failures.values()].sort((a, b) => b.count - a.count || cmp(a.action, b.action) || cmp(a.message, b.message)).slice(0, 5)
  s.places = clusterPlaces(placePoints)
  s.players = [...players].sort((a, b) => cmp(a, b))
  s.onlineMs = onlineMs(events, from, to, opts.openUntil ?? (evs.at(-1)?.ts ?? from), opts.onlineAtStart)
  return s
}

/**
 * Rollup of one day. `now` decides whether the day is final and where an open session ends
 * (now for today, the last event for a finished day).
 */
export function buildDayRollup (events: JournalEvent[], date: string, opts: { now?: number, bot?: string, onlineAtStart?: boolean } = {}): DayRollup {
  const now = opts.now ?? Date.now()
  const from = dayStart(date)
  const to = dayStart(nextDay(date))
  const sorted = events.filter(e => e.ts >= from && e.ts < to).sort((a, b) => a.ts - b.ts)
  const final = now >= to
  const openUntil = final ? (sorted.at(-1)?.ts ?? from) : now
  const totals = buildSection(sorted, from, to, { openUntil, onlineAtStart: opts.onlineAtStart })
  const hours: Record<string, RollupSection> = {}
  // Track online state across hours so an hour in the middle of a session counts as online.
  let online = opts.onlineAtStart ?? (sorted.find(e => e.type === 'connect' || e.type === 'disconnect')?.type === 'disconnect')
  const byHour = new Map<number, JournalEvent[]>()
  for (const e of sorted) {
    const h = hourOf(e.ts)
    if (!byHour.has(h)) byHour.set(h, [])
    byHour.get(h)!.push(e)
  }
  for (let h = 0; h < 24; h++) {
    const hFrom = from + h * 3_600_000
    const hTo = Math.min(to, hFrom + 3_600_000)
    if (hFrom >= openUntil && !byHour.has(h)) break
    const evs = byHour.get(h) ?? []
    const sec = buildSection(evs, hFrom, hTo, { openUntil, onlineAtStart: online })
    for (const e of evs) if (e.type === 'connect') online = true; else if (e.type === 'disconnect') online = false
    if (evs.length || sec.onlineMs > 0) hours[`${String(h).padStart(2, '0')}:00`] = sec
  }
  return { date, ...(opts.bot ? { bot: opts.bot } : {}), final, generatedAt: now, totals, hours }
}
