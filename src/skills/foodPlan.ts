// Pure planning for food self-sufficiency: where to scout, when to give up, which farm site
// to pick, how to lay a plot out around water, what to feed which animal, and which food
// spots are worth going back to. No mineflayer here, so all of it is unit-tested.

export interface XZ { x: number, z: number }
export interface Pos { x: number, y: number, z: number }

// ------------------------------------------------------------------ directions

/** Compass names, clockwise from east (Minecraft: +x east, +z south). */
export const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'] as const

/** Sector 0..7 of the direction from `from` to `to` (0 = east, 2 = south, 4 = west, 6 = north). */
export function sectorOf (from: XZ, to: XZ): number {
  const a = Math.atan2(to.z - from.z, to.x - from.x)
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
}

export function compass (from: XZ, to: XZ): string {
  return COMPASS[sectorOf(from, to)]!
}

// ------------------------------------------------------------------ scouting

export interface Waypoint extends XZ {
  /** 1 = innermost ring. */
  ring: number
  /** Distance from the centre. */
  distance: number
  /** Compass sector 0..7 as seen from the centre. */
  sector: number
}

export interface ScoutPatternOptions {
  /** Distance between rings, in blocks. Default 64 (animals are visible ~64 blocks out). */
  step?: number
  /** Distance between waypoints on a ring. Default 1.5 x step. */
  spacing?: number
  /** Angle of the first waypoint, in radians (0 = east). Default 0. */
  startAngle?: number
  /** Waypoints for which this returns true are dropped (protected areas, known water...). */
  skip? (p: XZ): boolean
}

/**
 * An expanding spiral of waypoints around `center`, out to `radius`: rings every `step`
 * blocks (plus one at `radius` when the last ring falls short), each ring walked round in
 * order and slightly offset from the previous one so the path keeps turning the same way.
 */
export function scoutWaypoints (center: XZ, radius: number, o: ScoutPatternOptions = {}): Waypoint[] {
  const step = Math.max(16, o.step ?? 64)
  const spacing = Math.max(16, o.spacing ?? step * 1.5)
  const radii: number[] = []
  for (let r = step; r <= radius + 0.001; r += step) radii.push(r)
  if (!radii.length || radius - radii[radii.length - 1]! > step / 2) radii.push(radius)
  const out: Waypoint[] = []
  radii.forEach((r, i) => {
    const n = Math.max(4, Math.round((2 * Math.PI * r) / spacing))
    const offset = (o.startAngle ?? 0) + i * (Math.PI / n)
    for (let k = 0; k < n; k++) {
      const a = offset + (2 * Math.PI * k) / n
      const p = { x: Math.round(center.x + Math.cos(a) * r), z: Math.round(center.z + Math.sin(a) * r) }
      if (o.skip?.(p)) continue
      out.push({ ...p, ring: i + 1, distance: Math.round(r), sector: sectorOf(center, p) })
    }
  })
  return out
}

export interface ScoutProgress {
  legs: number
  /** Legs in a row that ended stuck or blocked. */
  consecutiveFailures: number
  /** Blocks walked so far (straight-line sum of legs). */
  walked: number
  elapsedMs: number
  night: boolean
  health: number
  hostilesNear: number
}

export interface ScoutLimits {
  maxLegs: number
  maxFailures: number
  maxWalk: number
  maxMs: number
  atNight: boolean
  /** Stop when health drops to this or lower. */
  minHealth: number
}

export const DEFAULT_SCOUT_LIMITS: ScoutLimits = { maxLegs: 24, maxFailures: 4, maxWalk: 2400, maxMs: 8 * 60_000, atNight: false, minHealth: 6 }

/** Why scouting should stop now, or null to keep going. */
export function scoutStopReason (p: ScoutProgress, l: ScoutLimits = DEFAULT_SCOUT_LIMITS): string | null {
  if (p.night && !l.atNight) return 'night fell'
  // Low health only stops scouting when something is around to hurt us: health won't come back
  // without food, so refusing to scout at low health in a quiet daytime world is a deadlock.
  if (p.health <= l.minHealth && p.hostilesNear > 0) return `health is low (${Math.round(p.health)}/20) with mobs near`
  if (p.hostilesNear >= 3) return 'too many mobs around'
  if (p.consecutiveFailures >= l.maxFailures) return `stuck ${p.consecutiveFailures} times in a row`
  if (p.legs >= l.maxLegs) return `walked ${p.legs} legs`
  if (p.walked >= l.maxWalk) return `walked ${Math.round(p.walked)} blocks`
  if (p.elapsedMs >= l.maxMs) return `scouted for ${Math.round(p.elapsedMs / 60_000)} minutes`
  return null
}

/**
 * Index of the next waypoint to try, skipping visited ones and waypoints further out in a
 * sector where an inner leg already got stuck (a lake, a cliff, the sea). -1 when done.
 */
export function nextWaypoint (wps: readonly Waypoint[], visited: ReadonlySet<number>, blocked: ReadonlyMap<number, number>): number {
  for (let i = 0; i < wps.length; i++) {
    if (visited.has(i)) continue
    const w = wps[i]!
    const stuckAt = blocked.get(w.sector)
    if (stuckAt !== undefined && w.ring >= stuckAt) continue
    return i
  }
  return -1
}

/** "east and north-east" style summary of the sectors scouted. */
export function sectorsText (sectors: Iterable<number>): string {
  const names = [...new Set(sectors)].sort((a, b) => a - b).map(s => COMPASS[s]!)
  if (!names.length) return 'nowhere'
  if (names.length >= 7) return 'all around'
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ------------------------------------------------------------------ food spots

export type FoodSpotKind = 'animals' | 'village_farm' | 'water' | 'grass'

export interface FoodSpot extends Pos {
  kind: FoodSpotKind
  dim?: string
  /** When it was last seen with food (epoch ms). */
  seen: number
  /** Animals / ripe crops / water blocks seen there. */
  count: number
  animals?: string[]
  /** Visits in a row that found nothing. */
  emptyVisits?: number
  emptyAt?: number
}

/** How long a spot stays worth a trip. Animals wander off; water and village farms stay. */
export const SPOT_TTL_MS: Record<FoodSpotKind, number> = {
  animals: 6 * 3600_000,
  village_farm: 3 * 24 * 3600_000,
  water: 30 * 24 * 3600_000,
  grass: 7 * 24 * 3600_000
}
/** After an empty visit, leave a spot alone this long. */
export const SPOT_EMPTY_PAUSE_MS = 30 * 60_000

/** Adds or refreshes a spot; a spot of the same kind within `near` blocks is replaced. Keeps at most `max` per kind. */
export function mergeSpot (spots: readonly FoodSpot[], spot: FoodSpot, near = 32, max = 8): FoodSpot[] {
  const same = (s: FoodSpot) => s.kind === spot.kind && (s.dim ?? '') === (spot.dim ?? '') && Math.hypot(s.x - spot.x, s.z - spot.z) <= near
  const rest = spots.filter(s => !same(s))
  const kind = [spot, ...rest.filter(s => s.kind === spot.kind)].sort((a, b) => b.seen - a.seen).slice(0, max)
  return [...rest.filter(s => s.kind !== spot.kind), ...kind]
}

/** Marks the spot nearest `at` (same kind, within `near`) as visited and empty; drops it after two empty visits. */
export function markSpotEmpty (spots: readonly FoodSpot[], kind: FoodSpotKind, at: XZ, now: number, near = 32): FoodSpot[] {
  const out: FoodSpot[] = []
  for (const s of spots) {
    if (s.kind !== kind || Math.hypot(s.x - at.x, s.z - at.z) > near) { out.push(s); continue }
    const emptyVisits = (s.emptyVisits ?? 0) + 1
    if (emptyVisits >= 2) continue
    out.push({ ...s, emptyVisits, emptyAt: now })
  }
  return out
}

/** Spots of these kinds worth visiting now, best first: fresh, not just found empty, more food, closer. */
export function rankSpots (spots: readonly FoodSpot[], kinds: readonly FoodSpotKind[], now: number, from: XZ, dim?: string): FoodSpot[] {
  return spots
    .filter(s => kinds.includes(s.kind) && (!dim || !s.dim || s.dim === dim))
    .filter(s => now - s.seen <= SPOT_TTL_MS[s.kind])
    .filter(s => !s.emptyAt || now - s.emptyAt >= SPOT_EMPTY_PAUSE_MS)
    .map(s => ({ s, d: Math.hypot(s.x - from.x, s.z - from.z) }))
    .sort((a, b) => (b.s.count - b.d / 32) - (a.s.count - a.d / 32))
    .map(x => x.s)
}

// ------------------------------------------------------------------ farm site and plot

/** What one ground cell of a candidate plot is, at the water's height. */
export type CellKind =
  | 'tillable' // grass/dirt with air or a plant above
  | 'water'
  | 'farmland' // already tilled: somebody's field (or ours)
  | 'build' // placed blocks: planks, cobblestone, glass, fences, torches, beds, chests...
  | 'protected'
  | 'other' // sand, stone, a tree, a hole, a step up or down

export interface SiteCandidate {
  /** The water block the plot is laid around. */
  water: Pos
  /** Kinds of the cells in the plot square (size x size, centre included), keyed "dx,dz". */
  cells: Record<string, CellKind>
  /** Kinds found in a ring of `margin` blocks around the square (builds nearby rule a site out). */
  around: CellKind[]
  /** Distance from where the farm should be (home, a place, the bot). */
  distance: number
}

export interface SiteRules {
  /** Tillable cells needed (a strip along a shore is fine). Default 8. */
  minTillable: number
  /** Accept farmland in the plot (only for re-using the bot's own farm). Default false. */
  allowFarmland: boolean
}

/** Score of a site (higher is better), or null when it must not be used. */
export function scoreSite (c: SiteCandidate, rules: Partial<SiteRules> = {}): number | null {
  const r: SiteRules = { minTillable: 8, allowFarmland: false, ...rules }
  const kinds = Object.values(c.cells)
  if (kinds.includes('protected') || c.around.includes('protected')) return null
  if (kinds.includes('build') || c.around.includes('build')) return null
  if (!r.allowFarmland && (kinds.includes('farmland') || c.around.includes('farmland'))) return null
  const land = Object.entries(c.cells).filter(([k]) => k !== '0,0')
  const till = land.filter(([, v]) => v === 'tillable').length
  if (!land.length || till < r.minTillable) return null
  // more tillable cells, fewer extra water holes, closer is better
  const water = land.filter(([, v]) => v === 'water').length
  return till - water * 0.5 - c.distance / 8
}

/** The best usable site, or null. */
export function chooseFarmSite<T extends SiteCandidate> (cands: readonly T[], rules: Partial<SiteRules> = {}): T | null {
  let best: T | null = null
  let bestScore = -Infinity
  for (const c of cands) {
    const s = scoreSite(c, rules)
    if (s !== null && s > bestScore) { best = c; bestScore = s }
  }
  return best
}

export interface PlotLayout {
  center: Pos
  size: number
  /** Ground cells to till (same y as the water), nearest to the water first. */
  till: Pos[]
  /** Fence ring one block outside the plot (on top of the ground, y+1), minus the gap. */
  fence: Pos[]
  /** The opening left in the fence so the bot (and nothing on its own) can walk in. */
  gap: Pos
  /** Torch spots: on the four fence corners (y+2 on top of a fence post). */
  torches: Pos[]
}

/**
 * A square plot of `size` (odd, 3..9) around a water block: every cell but the water is
 * tilled (water hydrates farmland up to 4 blocks away, so 9x9 is the most one block can
 * keep wet). The fence goes one ring outside with a gap in the middle of the south side.
 */
export function plotLayout (water: Pos, size = 9): PlotLayout {
  const s = Math.max(3, Math.min(9, size % 2 ? size : size - 1))
  const h = (s - 1) / 2
  const till: Pos[] = []
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      if (dx === 0 && dz === 0) continue
      till.push({ x: water.x + dx, y: water.y, z: water.z + dz })
    }
  }
  till.sort((a, b) => (Math.abs(a.x - water.x) + Math.abs(a.z - water.z)) - (Math.abs(b.x - water.x) + Math.abs(b.z - water.z)))
  const f = h + 1
  const gap = { x: water.x, y: water.y + 1, z: water.z + f }
  const fence: Pos[] = []
  for (let dx = -f; dx <= f; dx++) {
    for (let dz = -f; dz <= f; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== f) continue
      const p = { x: water.x + dx, y: water.y + 1, z: water.z + dz }
      if (p.x === gap.x && p.z === gap.z) continue
      fence.push(p)
    }
  }
  const torches = [[-f, -f], [f, -f], [-f, f], [f, f]].map(([dx, dz]) => ({ x: water.x + dx!, y: water.y + 2, z: water.z + dz! }))
  return { center: { ...water }, size: s, till, fence, gap, torches }
}

// ------------------------------------------------------------------ seeds and crops

/** Seed items in order of preference for a new farm. */
export const FARM_SEEDS = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'] as const

/** The seed to plant first (most of), or null. */
export function pickFarmSeed (inv: Record<string, number>): string | null {
  return [...FARM_SEEDS].filter(s => (inv[s] ?? 0) > 0).sort((a, b) => (inv[b] ?? 0) - (inv[a] ?? 0))[0] ?? null
}

export function seedCount (inv: Record<string, number>): number {
  return FARM_SEEDS.reduce((n, s) => n + (inv[s] ?? 0), 0)
}

/**
 * Bread to bake from the wheat in stock, keeping `keepWheat` wheat for breeding. Seeds are
 * a separate item, so baking never eats into the replanting stock.
 */
export function breadToBake (wheat: number, keepWheat = 0): number {
  return Math.max(0, Math.floor((wheat - keepWheat) / 3))
}

// ------------------------------------------------------------------ breeding

/** What each animal is bred with (only items the bot can farm or find). */
export const BREED_FOOD: Record<string, readonly string[]> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion']
}

/** The breeding item for this animal with at least `need` in the inventory, or null. */
export function breedFoodFor (animal: string, inv: Record<string, number>, need = 2): string | null {
  return (BREED_FOOD[animal] ?? []).find(f => (inv[f] ?? 0) >= need) ?? null
}

export interface BreedOptions {
  animals?: readonly string[]
  /** Don't breed a kind that already has this many adults around. Default 12. */
  maxHerd?: number
  /** Keep this many seeds (any kind) for replanting before feeding chickens. Default 8. */
  keepSeeds?: number
}

/**
 * Which animal to breed now with what: the first kind with at least two adults, food for
 * two, and fewer than maxHerd adults. Seeds stay reserved for replanting.
 */
export function breedPlan (adults: Record<string, number>, inv: Record<string, number>, o: BreedOptions = {}): { animal: string, food: string } | null {
  const maxHerd = o.maxHerd ?? 12
  const keepSeeds = o.keepSeeds ?? 8
  const kinds = (o.animals ?? Object.keys(BREED_FOOD)).filter(a => BREED_FOOD[a])
  const ranked = kinds.filter(a => (adults[a] ?? 0) >= 2 && (adults[a] ?? 0) < maxHerd).sort((a, b) => (adults[b] ?? 0) - (adults[a] ?? 0))
  for (const a of ranked) {
    const avail: Record<string, number> = { ...inv }
    if (a === 'chicken') for (const s of ['wheat_seeds', 'beetroot_seeds']) avail[s] = Math.max(0, (avail[s] ?? 0) - keepSeeds)
    const food = breedFoodFor(a, avail)
    if (food) return { animal: a, food }
  }
  return null
}
