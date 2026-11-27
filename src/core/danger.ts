// Danger zones: places where something dangerous was seen (a shooter, a patrol), remembered for a
// few minutes so the bot's own jobs (scouting, chopping, food trips) don't walk straight back into
// them once the fight is over. Plain positions and times, no game objects: the pure helpers are
// unit-tested, and dangerMemory(owner) keeps one list per agent (or per anything) in a WeakMap.
// Game code records zones (skills/ranged.ts) and reads them (find_target, chop_tree, find_food).

export interface DangerPos { x: number, y?: number, z: number }

export interface DangerZone {
  x: number
  y: number
  z: number
  /** What was there: a mob name ('skeleton', 'pillager') or 'patrol'. */
  kind: string
  /** Horizontal radius to keep out of, blocks. */
  radius: number
  /** When it was first seen and last refreshed (ms). */
  since: number
  seenAt: number
  /** Forgotten after this (ms). */
  until: number
  /** How many were seen together (a patrol's size), when known. */
  count?: number
  /** Only positions within this many blocks above or below count (a death in a cave doesn't fence off the ground above). Unset: any height. */
  yRange?: number
}

/** How long a lone shooter's zone is remembered. */
export const DANGER_TTL_MS = 5 * 60_000
/** How long a patrol's zone is remembered. */
export const PATROL_TTL_MS = 10 * 60_000
/** Default radius around a sighting. */
export const DANGER_RADIUS = 24
/** At most this many zones are kept (the oldest go first). */
export const MAX_ZONES = 32

export interface DangerSighting extends DangerPos { kind: string, radius?: number, ttlMs?: number, count?: number, yRange?: number }

const flat = (a: DangerPos, b: DangerPos) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Adds a sighting to `zones` and returns the new list (the input is not changed). A sighting of the
 * same kind inside an existing zone refreshes that zone (position moved to the latest sighting,
 * time extended) instead of adding another one; expired zones are dropped.
 */
export function rememberDanger (zones: readonly DangerZone[], s: DangerSighting, now: number): DangerZone[] {
  const radius = s.radius ?? DANGER_RADIUS
  const ttl = s.ttlMs ?? (s.kind === 'patrol' ? PATROL_TTL_MS : DANGER_TTL_MS)
  const live = activeZones(zones, now)
  const i = live.findIndex(z => z.kind === s.kind && flat(z, s) <= Math.max(8, Math.min(z.radius, radius) / 2))
  const y = s.y ?? 64
  if (i >= 0) {
    const old = live[i]!
    live[i] = { ...old, x: s.x, y, z: s.z, radius: Math.max(old.radius, radius), seenAt: now, until: Math.max(old.until, now + ttl), count: s.count ?? old.count, ...(s.yRange !== undefined ? { yRange: s.yRange } : {}) }
    return live
  }
  live.push({ x: s.x, y, z: s.z, kind: s.kind, radius, since: now, seenAt: now, until: now + ttl, ...(s.count !== undefined ? { count: s.count } : {}), ...(s.yRange !== undefined ? { yRange: s.yRange } : {}) })
  if (live.length > MAX_ZONES) live.sort((a, b) => b.seenAt - a.seenAt).length = MAX_ZONES
  return live
}

/** The zones not yet expired. */
export function activeZones (zones: readonly DangerZone[], now: number): DangerZone[] {
  return zones.filter(z => z.until > now)
}

/** Whether `pos` is within a zone's height band (zones without yRange, or positions without y, always are). */
export const inZoneHeight = (z: DangerZone, pos: DangerPos): boolean => z.yRange === undefined || pos.y === undefined || Math.abs(pos.y - z.y) <= z.yRange

/**
 * The zone `pos` is in (horizontally, plus `margin`, and within the zone's height band), nearest
 * centre first, or null. `kind` only looks at zones of that kind.
 */
export function isInDanger (zones: readonly DangerZone[], pos: DangerPos, now: number, margin = 0, kind?: string): DangerZone | null {
  let best: DangerZone | null = null
  let bestD = Infinity
  for (const z of zones) {
    if (z.until <= now) continue
    if (kind !== undefined && z.kind !== kind) continue
    if (!inZoneHeight(z, pos)) continue
    const d = flat(z, pos)
    if (d <= z.radius + margin && d < bestD) { best = z; bestD = d }
  }
  return best
}

/** The points outside every zone (waypoints, trees, food spots), in their original order. */
export function avoidZones<T extends DangerPos> (points: readonly T[], zones: readonly DangerZone[], now: number, margin = 0): T[] {
  return points.filter(p => !isInDanger(zones, p, now, margin))
}

/**
 * The zone a straight walk from `a` to `b` passes through, or null. A zone `a` already stands in
 * doesn't count when the walk leads out of it (getting away is fine).
 */
export function crossesDanger (a: DangerPos, b: DangerPos, zones: readonly DangerZone[], now: number): DangerZone | null {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  for (const z of zones) {
    if (z.until <= now) continue
    // a zone with a height band (a death in a cave) only matters for walks that start or end in that band
    if (!inZoneHeight(z, a) && !inZoneHeight(z, b)) continue
    const inA = flat(z, a) <= z.radius
    if (inA && flat(z, b) >= flat(z, a)) continue
    // closest point of the segment to the zone centre
    const t = len2 ? Math.max(0, Math.min(1, ((z.x - a.x) * dx + (z.z - a.z) * dz) / len2)) : 0
    const d = Math.hypot(a.x + dx * t - z.x, a.z + dz * t - z.z)
    if (d <= z.radius && !inA) return z
    if (inA && flat(z, b) <= z.radius) return z
  }
  return null
}

/** Removes the zones whose centre is within `radius` of `pos` (the shooter there was killed). */
export function clearDanger (zones: readonly DangerZone[], pos: DangerPos, radius: number, kind?: string): DangerZone[] {
  return zones.filter(z => !(flat(z, pos) <= radius && (kind === undefined || z.kind === kind)))
}

/** One owner's remembered zones. */
export class DangerMemory {
  zones: DangerZone[] = []
  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now()

  remember (s: DangerSighting): DangerZone {
    const t = this.now()
    this.zones = rememberDanger(this.zones, s, t)
    return isInDanger(this.zones, s, t)!
  }

  /** The zone `pos` is in, or null (`kind`: only zones of that kind). */
  isInDanger (pos: DangerPos, margin = 0, kind?: string): DangerZone | null {
    return isInDanger(this.zones, pos, this.now(), margin, kind)
  }

  /** The points outside every zone. */
  avoid<T extends DangerPos> (points: readonly T[], margin = 0): T[] {
    return avoidZones(points, this.zones, this.now(), margin)
  }

  /** The zone a straight walk from `a` to `b` passes through, or null. */
  crosses (a: DangerPos, b: DangerPos): DangerZone | null {
    return crossesDanger(a, b, this.zones, this.now())
  }

  clearNear (pos: DangerPos, radius: number, kind?: string): void {
    this.zones = clearDanger(this.zones, pos, radius, kind)
  }

  /** The zones not yet expired. */
  active (): DangerZone[] {
    return activeZones(this.zones, this.now())
  }
}

const memories = new WeakMap<object, DangerMemory>()

/** The danger memory of an agent (any object works as the key); created on first use. */
export function dangerMemory (owner: object): DangerMemory {
  let m = memories.get(owner)
  if (!m) memories.set(owner, m = new DangerMemory())
  return m
}

/** Short text for logs and chat: "pillager patrol of 4 12 blocks north-west, 3 min ago". */
export function describeZone (z: DangerZone, now: number): string {
  const what = z.kind === 'patrol' ? `patrol${z.count ? ` of ${z.count}` : ''}` : z.kind
  const ago = Math.round((now - z.seenAt) / 60_000)
  return `${what} at ${Math.round(z.x)} ${Math.round(z.z)}${ago ? `, ${ago} min ago` : ''}`
}
