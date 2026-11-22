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

const CONFIRM_RADIUS = 8
const CONFIRM_WINDOW_MS = 10 * 60_000

export class ProtectedAreas {
  readonly file: string
  zones: Zone[] = []
  /** Single refusals waiting for a second one nearby; lag rollbacks look like refusals too. */
  private suspects: { x: number, y: number, z: number, t: number }[] = []

  constructor (file: string) {
    this.file = file
    try { this.zones = JSON.parse(readFileSync(file, 'utf8')).zones ?? [] } catch {}
  }

  isProtected (p: { x: number, y: number, z: number }, radius = ZONE_RADIUS): boolean {
    return this.zones.some(z => Math.abs(z.x - p.x) <= radius && Math.abs(z.z - p.z) <= radius && Math.abs(z.y - p.y) <= radius * 2)
  }

  /**
   * Records a refused break. A zone is only created after a second refusal within 8 blocks
   * in 10 minutes (one rollback can be lag), or immediately with `confirmed`. Returns true if
   * this created a new zone.
   */
  add (p: { x: number, y: number, z: number }, opts: { confirmed?: boolean } = {}): boolean {
    if (this.isProtected(p, ZONE_RADIUS / 2)) return false
    if (!opts.confirmed) {
      const now = Date.now()
      this.suspects = this.suspects.filter(s => now - s.t < CONFIRM_WINDOW_MS)
      const near = this.suspects.some(s => Math.abs(s.x - p.x) <= CONFIRM_RADIUS && Math.abs(s.y - p.y) <= CONFIRM_RADIUS && Math.abs(s.z - p.z) <= CONFIRM_RADIUS)
      if (!near) {
        this.suspects.push({ x: p.x, y: p.y, z: p.z, t: now })
        return false
      }
    }
    this.zones.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: new Date().toISOString() })
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
