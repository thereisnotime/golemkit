// Query filters over journal events (pure; the Journal reads the files and applies these).
import type { JournalEvent } from './types.ts'

export interface JournalQuery {
  types?: string[]
  /** Epoch ms or a range spec ("1h", "today", "yesterday", "2026-11-20"). */
  since?: number | string
  until?: number
  near?: { x: number, y?: number, z: number, r: number }
  /** Events involving this player (chat, whispers, seen/joined/left, killer, kill target). */
  player?: string
  /** Case-insensitive substring over the event's data. */
  text?: string
  /** Newest N matches (results stay oldest first). Default 50. */
  limit?: number
}

const PLAYER_FIELDS = ['player', 'from', 'to', 'killer', 'entity', 'caller']

export function involvesPlayer (e: JournalEvent, player: string): boolean {
  const p = player.toLowerCase()
  for (const f of PLAYER_FIELDS) {
    const v = e.data?.[f]
    if (typeof v === 'string' && v.toLowerCase().replace(/^player:/, '') === p) return true
  }
  if (Array.isArray(e.data?.players)) return e.data.players.some((x: unknown) => typeof x === 'string' && x.toLowerCase() === p)
  return false
}

export function matchEvent (e: JournalEvent, q: JournalQuery & { since?: number }): boolean {
  if (q.types?.length && !q.types.includes(e.type)) return false
  if (typeof q.since === 'number' && e.ts < q.since) return false
  if (q.until !== undefined && e.ts > q.until) return false
  if (q.near) {
    if (!e.pos) return false
    const dx = e.pos.x - q.near.x
    const dz = e.pos.z - q.near.z
    const dy = q.near.y === undefined ? 0 : e.pos.y - q.near.y
    if (dx * dx + dy * dy + dz * dz > q.near.r * q.near.r) return false
  }
  if (q.player && !involvesPlayer(e, q.player)) return false
  if (q.text && !JSON.stringify(e.data ?? {}).toLowerCase().includes(q.text.toLowerCase())) return false
  return true
}

/** Filters, sorts oldest first and keeps the newest `limit`. */
export function filterEvents (events: Iterable<JournalEvent>, q: JournalQuery & { since?: number }): JournalEvent[] {
  const out: JournalEvent[] = []
  for (const e of events) if (matchEvent(e, q)) out.push(e)
  out.sort((a, b) => a.ts - b.ts)
  const limit = q.limit ?? 50
  return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out
}
