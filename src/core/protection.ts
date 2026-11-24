// Learns where the server refuses block breaking (spawn protection, claims) and keeps the
// pathfinder from planning digs there.
//
// A refused break looks like this: we finish digging, mineflayer marks the block as air,
// then the server sends a block update restoring the old block. Without help the
// pathfinder re-plans through the same block forever ("can't break dirt").
//
// Zones are kept per server in data/protected-<host>-<port>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Zone { x: number, y: number, z: number, at: string }

const ZONE_RADIUS = 20

/** A second refusal confirms a zone only this close to the first, */
export const CONFIRM_RADIUS = 8
/** within this long of it, */
export const CONFIRM_WINDOW_MS = 5 * 60_000
/** and at least this long after it: one lag rollback reverts several blocks at once and counts once. */
export const CONFIRM_GAP_MS = 5_000

export interface Refusal { x: number, y: number, z: number, t: number }

export interface RefusalOptions {
  /** Confirmed some other way (inside vanilla spawn protection, a retry refused again): record at once. */
  confirmed?: boolean
  /** A crop, farmland or plant break (harvest, tilling, grass for seeds): rollbacks there are lag, never a zone. */
  crop?: boolean
  now?: number
}

/**
 * What one refused break means (pure): 'zone' when it confirms a protected area, 'suspect' when
 * it is only noted (a first refusal, or one in the same lag burst as an earlier one), 'ignore'
 * for crop and plant breaks. A zone needs a second refusal within CONFIRM_RADIUS blocks of an
 * earlier one, CONFIRM_GAP_MS to CONFIRM_WINDOW_MS after it, or `confirmed`.
 */
export function refusalVerdict (suspects: readonly Refusal[], p: { x: number, y: number, z: number }, opts: RefusalOptions = {}): 'zone' | 'suspect' | 'ignore' {
  if (opts.crop) return 'ignore'
  if (opts.confirmed) return 'zone'
  const now = opts.now ?? Date.now()
  const earlier = suspects.some(s => now - s.t >= CONFIRM_GAP_MS && now - s.t < CONFIRM_WINDOW_MS &&
    Math.abs(s.x - p.x) <= CONFIRM_RADIUS && Math.abs(s.y - p.y) <= CONFIRM_RADIUS && Math.abs(s.z - p.z) <= CONFIRM_RADIUS)
  return earlier ? 'zone' : 'suspect'
}

export class ProtectedAreas {
  readonly file: string
  zones: Zone[] = []
  /** Single refusals waiting for a second one nearby; lag rollbacks look like refusals too. */
  private suspects: Refusal[] = []

  constructor (file: string) {
    this.file = file
    try { this.zones = JSON.parse(readFileSync(file, 'utf8')).zones ?? [] } catch {}
  }

  isProtected (p: { x: number, y: number, z: number }, radius = ZONE_RADIUS): boolean {
    return !!this.zoneAt(p, radius)
  }

  /** The zone covering `p`, if any. */
  zoneAt (p: { x: number, y: number, z: number }, radius = ZONE_RADIUS): Zone | undefined {
    return this.zones.find(z => Math.abs(z.x - p.x) <= radius && Math.abs(z.z - p.z) <= radius && Math.abs(z.y - p.y) <= radius * 2)
  }

  /**
   * Records a refused break (see refusalVerdict): a zone only after a second refusal within 8
   * blocks, 5 seconds to 5 minutes after the first (one rollback can be lag, and a lag burst
   * reverts several blocks at once), or right away with `confirmed`; never for `crop` breaks.
   * Returns true if this created a new zone.
   */
  add (p: { x: number, y: number, z: number }, opts: RefusalOptions = {}): boolean {
    if (this.isProtected(p, ZONE_RADIUS / 2)) return false
    const now = opts.now ?? Date.now()
    const verdict = refusalVerdict(this.suspects, p, { ...opts, now })
    if (verdict === 'ignore') return false
    if (verdict === 'suspect') {
      this.suspects = [...this.suspects.filter(s => now - s.t < CONFIRM_WINDOW_MS), { x: p.x, y: p.y, z: p.z, t: now }].slice(-32)
      return false
    }
    this.zones.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: new Date(now).toISOString() })
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ zones: this.zones }, null, 2) + '\n')
    } catch {}
    return true
  }

  clear (): void {
    this.zones = []
    try { writeFileSync(this.file, JSON.stringify({ zones: [] }) + '\n') } catch {}
  }

  /** Pathfinder exclusion: digging inside a zone costs Infinity (never planned). */
  breakCost = (block: { position: { x: number, y: number, z: number } }): number =>
    this.isProtected(block.position) ? Infinity : 0
}
