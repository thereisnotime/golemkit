// Where to look for a tree next, the wood ladder (pure, unit tested; woodcutting.ts runs it).
// Like the food ladder (foodPlan.ts): first trees it remembers, nearest first, then search rings
// that widen (32, 64, 128, 250 by default). The inner rings are a scan of what is loaded around
// the bot; the outer ones are a scouting trip (a spiral of waypoints) out and back. A ring that
// came up empty is remembered for a while, so the next run starts one ring further out instead
// of failing at 32 blocks for hours.
import { nextRing, recordSearch, type SearchRecord, type XZ } from './foodPlan.ts'

export const DEFAULT_TREE_RINGS = [32, 64, 128, 250] as const
/** Rings up to this are a scan from where the bot stands (loaded chunks); wider ones are trips. */
export const SCAN_RADIUS = 64
/** How long an empty ring is remembered. Saplings take a while to grow back. */
export const TREE_RING_MEMORY_MS = 20 * 60_000
/** A remembered tree spot found empty (felled, or someone else cut it) is left alone this long. */
export const TREE_SPOT_PAUSE_MS = 30 * 60_000
/** Spots unseen for longer than this are dropped. */
export const TREE_SPOT_TTL_MS = 3 * 24 * 60 * 60_000

export interface TreeSpot {
  x: number
  y: number
  z: number
  dim?: string
  wood?: string
  /** Natural trees counted around the spot when it was seen. */
  count: number
  /** Epoch ms it was last seen with trees. */
  seen: number
  /** Epoch ms it was last found without a tree it may cut. */
  emptyAt?: number
}

export type { SearchRecord }

const flat = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z)

/** Adds or refreshes a spot (one spot per `near` blocks), newest first, at most `max`. */
export function mergeTreeSpot (spots: readonly TreeSpot[], spot: TreeSpot, near = 24, max = 24): TreeSpot[] {
  const rest = spots.filter(s => !(s.dim === spot.dim && flat(s, spot) <= near))
  const old = spots.find(s => s.dim === spot.dim && flat(s, spot) <= near)
  const merged: TreeSpot = { ...spot, count: Math.max(spot.count, old && !old.emptyAt ? old.count : 0) }
  return [merged, ...rest].slice(0, max)
}

/** Marks the spots around `at` empty (no tree it may cut there right now). */
export function markTreeSpotEmpty (spots: readonly TreeSpot[], at: XZ, now: number, near = 24, dim?: string): TreeSpot[] {
  return spots.map(s => s.dim === dim && flat(s, at) <= near ? { ...s, emptyAt: now } : s)
}

/**
 * Remembered spots worth a trip, nearest first: same dimension, within `maxDistance`, not found
 * empty within the pause, not too old. Spots in a danger zone or a protected area are dropped by
 * `skip`.
 */
export function rankTreeSpots (spots: readonly TreeSpot[], from: XZ, now: number, o: { dim?: string, maxDistance?: number, skip?: (p: XZ) => boolean } = {}): TreeSpot[] {
  return spots
    .filter(s => s.dim === o.dim && now - s.seen < TREE_SPOT_TTL_MS)
    .filter(s => !s.emptyAt || now - s.emptyAt >= TREE_SPOT_PAUSE_MS)
    .filter(s => flat(s, from) <= (o.maxDistance ?? Infinity))
    .filter(s => !o.skip?.(s))
    .sort((a, b) => flat(a, from) - flat(b, from))
}

export type TreeStep =
  | { step: 'spot', spot: TreeSpot, reason: string }
  | { step: 'scan', radius: number, reason: string }
  | { step: 'scout', radius: number, covered: number, reason: string }

export interface TreeWorld {
  /** Where the search is centred (home, or where the bot stands). */
  from: XZ
  dim?: string
  now: number
  spots: readonly TreeSpot[]
  searches: readonly SearchRecord[]
}

export interface TreeStepOptions {
  /** Search rings, smallest first. Default DEFAULT_TREE_RINGS. */
  rings?: readonly number[]
  ringMemoryMs?: number
  /** Spots in danger zones or protected areas. */
  skip?: (p: XZ) => boolean
  /** Steps already tried in this run (spots by "x,z", rings by radius). */
  tried?: ReadonlySet<string>
}

export const spotKey = (s: XZ) => `${s.x},${s.z}`

/**
 * The next place to look for a tree: a remembered spot inside the widest ring (nearest first),
 * else the smallest ring that no recent empty search covered, as a scan (up to SCAN_RADIUS) or
 * a scouting trip. Null when every ring came up empty within the memory and no spot is left.
 */
export function nextTreeStep (w: TreeWorld, o: TreeStepOptions = {}): TreeStep | null {
  const rings = [...(o.rings?.length ? o.rings : DEFAULT_TREE_RINGS)].sort((a, b) => a - b)
  const widest = rings[rings.length - 1]!
  const tried = o.tried ?? new Set<string>()
  const spot = rankTreeSpots(w.spots, w.from, w.now, { dim: w.dim, maxDistance: widest, skip: o.skip }).find(s => !tried.has(spotKey(s)))
  if (spot) return { step: 'spot', spot, reason: `trees I remember ${Math.round(flat(spot, w.from))} blocks away` }
  const searches = [...w.searches, ...[...tried].filter(k => k.startsWith('ring:')).map(k => ({ radius: Number(k.slice(5)), at: w.now, found: false }))]
  const ring = nextRing(searches, rings, w.now, o.ringMemoryMs ?? TREE_RING_MEMORY_MS)
  if (!ring) return null
  if (ring.radius <= SCAN_RADIUS) return { step: 'scan', radius: ring.radius, reason: ring.covered ? `nothing within ${ring.covered}, looking ${ring.radius} out` : `looking ${ring.radius} out` }
  return { step: 'scout', radius: ring.radius, covered: ring.covered, reason: `nothing within ${ring.covered || SCAN_RADIUS}, scouting ${ring.radius} out` }
}

/** Records how a ring search went (keeps the last dozen, drops old ones). */
export function recordTreeSearch (searches: readonly SearchRecord[], radius: number, found: boolean, now: number): SearchRecord[] {
  return recordSearch(searches, { radius, at: now, found }, TREE_RING_MEMORY_MS * 3)
}

/** When the ladder has nothing left: how long until the oldest empty ring is forgotten. */
export function treeRetryInMs (searches: readonly SearchRecord[], now: number, memoryMs = TREE_RING_MEMORY_MS): number {
  const empty = searches.filter(s => !s.found && now - s.at < memoryMs)
  if (!empty.length) return 0
  return Math.max(0, Math.min(...empty.map(s => s.at + memoryMs - now)))
}

/** Wood worth in plank units of an item (a log is 4 planks), 0 for anything else. */
export function woodValue (name: string): number {
  if (name.startsWith('stripped_') && /_(log|wood|stem|hyphae)$/.test(name)) return 4
  if (/_(log|wood|stem|hyphae)$/.test(name) && !name.startsWith('mushroom')) return 4
  if (name === 'bamboo_block') return 2
  if (/_planks$/.test(name)) return 1
  return 0
}

/**
 * What to take out of a chest to cover `want` plank units: logs first (they make any plank kind
 * and pack 4 to a slot), then planks of the kind that has the most. Pure.
 */
export function woodToTake (contents: Record<string, number>, want: number): Record<string, number> {
  const out: Record<string, number> = {}
  let left = want
  const logs = Object.entries(contents).filter(([k, v]) => v > 0 && woodValue(k) === 4).sort((a, b) => b[1] - a[1])
  for (const [k, v] of logs) {
    if (left <= 0) break
    const n = Math.min(v, Math.ceil(left / 4))
    out[k] = n
    left -= 4 * n
  }
  const planks = Object.entries(contents).filter(([k, v]) => v > 0 && /_planks$/.test(k)).sort((a, b) => b[1] - a[1])
  for (const [k, v] of planks) {
    if (left <= 0) break
    const n = Math.min(v, Math.max(left, 2)) // never a lone plank: recipes take one kind
    if (n < 2) continue
    out[k] = n
    left -= n
  }
  return out
}
