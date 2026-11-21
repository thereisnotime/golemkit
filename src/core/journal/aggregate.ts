// Pure, clock-injected helpers that keep the journal small: per-type rate caps, debounced
// inventory diffs, aggregated damage and per-area block counts. The capture layer feeds them
// and calls poll(now) on a timer; tests drive them with fake times.
import type { Pos } from './types.ts'

/** Allows at most caps[type] (or caps.default) events per type per wall-clock minute. */
export class RateLimiter {
  private readonly caps: Record<string, number>
  private minute = -1
  private counts = new Map<string, number>()
  private dropped = new Map<string, number>()
  private pendingDropped: [string, number][] = []

  constructor (caps: Record<string, number>) {
    this.caps = caps
  }

  private roll (now: number): Map<string, number> | null {
    const m = Math.floor(now / 60_000)
    if (m === this.minute) return null
    const out = this.dropped
    this.minute = m
    this.counts = new Map()
    this.dropped = new Map()
    return out.size ? out : null
  }

  /** True if the event may be written. Dropped ones are counted. */
  allow (type: string, now: number): boolean {
    const prev = this.roll(now)
    if (prev) this.pendingDropped.push(...prev)
    const cap = this.caps[type] ?? this.caps.default ?? Infinity
    const n = this.counts.get(type) ?? 0
    if (n >= cap) {
      this.dropped.set(type, (this.dropped.get(type) ?? 0) + 1)
      return false
    }
    this.counts.set(type, n + 1)
    return true
  }

  /** Drop counts of finished minutes (call periodically); each becomes one journal_dropped event. */
  takeDropped (now: number): [string, number][] {
    const prev = this.roll(now)
    if (prev) this.pendingDropped.push(...prev)
    const out = this.pendingDropped
    this.pendingDropped = []
    return out
  }
}

export type Counts = Record<string, number>

export function countsDiff (before: Counts, after: Counts): { gained: Counts, lost: Counts } {
  const gained: Counts = {}
  const lost: Counts = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0)
    if (d > 0) gained[k] = d
    else if (d < 0) lost[k] = -d
  }
  return { gained, lost }
}

/**
 * Debounced inventory diffs: a burst of slot updates (crafting, picking up a stack, moving
 * items) settles for `quietMs` before the net change against the last settled inventory is
 * reported. Moving an item between slots nets to nothing.
 */
export class InventoryTracker {
  private base: Counts | null = null
  private latest: Counts | null = null
  private changedAt = 0
  private readonly quietMs: number
  private readonly maxMs: number
  private firstChangeAt = 0

  constructor (quietMs = 2000, maxMs = 15_000) {
    this.quietMs = quietMs
    this.maxMs = maxMs
  }

  /** Sets the baseline without reporting anything (spawn, respawn, after a death). */
  reset (snapshot: Counts): void {
    this.base = { ...snapshot }
    this.latest = null
  }

  get baseline (): Counts {
    return { ...(this.latest ?? this.base ?? {}) }
  }

  change (snapshot: Counts, now: number): void {
    if (!this.base) { this.base = { ...snapshot }; return }
    if (!this.latest) this.firstChangeAt = now
    this.latest = { ...snapshot }
    this.changedAt = now
  }

  /** Returns the settled diff once quiet for quietMs (or after maxMs of constant change), else null. */
  poll (now: number): { gained: Counts, lost: Counts } | null {
    if (!this.latest || !this.base) return null
    if (now - this.changedAt < this.quietMs && now - this.firstChangeAt < this.maxMs) return null
    const d = countsDiff(this.base, this.latest)
    this.base = this.latest
    this.latest = null
    return Object.keys(d.gained).length || Object.keys(d.lost).length ? d : null
  }
}

export interface DamageEntry { source: string, amount: number, hits: number, healthAfter: number, firstAt: number, pos?: Pos }

/** Collects hits per source and reports them windowMs after the first hit of a burst. */
export class DamageAggregator {
  private pending = new Map<string, DamageEntry>()
  private readonly windowMs: number

  constructor (windowMs = 10_000) {
    this.windowMs = windowMs
  }

  hit (source: string, amount: number, healthAfter: number, now: number, pos?: Pos): void {
    const e = this.pending.get(source)
    if (e) { e.amount += amount; e.hits++; e.healthAfter = healthAfter }
    else this.pending.set(source, { source, amount, hits: 1, healthAfter, firstAt: now, ...(pos ? { pos } : {}) })
  }

  poll (now: number, force = false): DamageEntry[] {
    const out: DamageEntry[] = []
    for (const [k, e] of this.pending) {
      if (force || now - e.firstAt >= this.windowMs) { out.push(e); this.pending.delete(k) }
    }
    return out
  }
}

export interface BlockArea { kind: 'broken' | 'placed', dim?: string, area: string, pos: Pos, blocks: Counts, count: number, firstAt: number }

/** Counts broken/placed blocks per 16x16 column (chunk) and dimension, reported windowMs after the first. */
export class BlockAggregator {
  private pending = new Map<string, BlockArea>()
  private readonly windowMs: number

  constructor (windowMs = 30_000) {
    this.windowMs = windowMs
  }

  add (kind: 'broken' | 'placed', name: string, pos: Pos, dim: string | undefined, now: number): void {
    const cx = Math.floor(pos.x / 16)
    const cz = Math.floor(pos.z / 16)
    const key = `${kind}|${dim ?? ''}|${cx},${cz}`
    let a = this.pending.get(key)
    if (!a) {
      a = { kind, ...(dim ? { dim } : {}), area: `${cx * 16 + 8} ${cz * 16 + 8}`, pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, blocks: {}, count: 0, firstAt: now }
      this.pending.set(key, a)
    }
    a.blocks[name] = (a.blocks[name] ?? 0) + 1
    a.count++
  }

  poll (now: number, force = false): BlockArea[] {
    const out: BlockArea[] = []
    for (const [k, a] of this.pending) {
      if (force || now - a.firstAt >= this.windowMs) { out.push(a); this.pending.delete(k) }
    }
    return out
  }
}
