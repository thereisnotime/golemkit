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
  /** Rings at or inside this radius are left out (an earlier, smaller search covered them). Default 0. */
  minRadius?: number
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
  const inner = o.minRadius ?? 0
  radii.forEach((r, i) => {
    if (r <= inner && r < radius) return
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

// ------------------------------------------------------------------ wet waypoints

/**
 * A dry stand-in for a scouting waypoint that lies over water or lava: the same direction a
 * bit closer in, or the same ring turned a little either way. `wet` says whether the surface
 * at a point is water/lava (true), dry (false) or not loaded (null). Known-dry points win,
 * then unknown ones; null when every candidate is known to be wet (open sea that way).
 */
export function dryWaypoint (center: XZ, w: XZ, wet: (p: XZ) => boolean | null): XZ | null {
  const r = Math.hypot(w.x - center.x, w.z - center.z)
  const a = Math.atan2(w.z - center.z, w.x - center.x)
  const at = (dist: number, turn: number): XZ => ({ x: Math.round(center.x + Math.cos(a + turn) * dist), z: Math.round(center.z + Math.sin(a + turn) * dist) })
  const cands: XZ[] = []
  for (const pull of [16, 32, 48]) if (r - pull >= 16) cands.push(at(r - pull, 0))
  for (const deg of [15, -15, 30, -30]) cands.push(at(r, deg * Math.PI / 180))
  for (const deg of [20, -20]) if (r - 24 >= 16) cands.push(at(r - 24, deg * Math.PI / 180))
  let unknown: XZ | null = null
  for (const c of cands) {
    const v = wet(c)
    if (v === false) return c
    if (v === null && !unknown) unknown = c
  }
  return unknown
}

// ------------------------------------------------------------------ the keep_fed ladder

/**
 * One thing keep_fed can do next. The ladder (planFood) climbs from what it carries to what it
 * knows, to searching wider and wider, to growing its own food:
 *   inventory: eat, cook, bread
 *   known:     withdraw (chest), harvest (crops in range), farm (its own, ripe or due), spot, hunt
 *   search:    scout (find_food) one ring wider than the last empty one
 *   farm:      plant (fill its farm), seeds (break grass), start_farm, breed, forage (stopgap)
 *   critical:  report (tell the owner once, stay safe)
 */
export type FoodStep =
  | 'eat' | 'cook' | 'bread' | 'withdraw' | 'harvest' | 'farm' | 'spot' | 'hunt'
  | 'scout' | 'seeds' | 'start_farm' | 'plant' | 'breed' | 'forage' | 'report'

export type FoodRung = 'inventory' | 'known' | 'search' | 'farm' | 'critical'

/** One find_food run: how far it went out and whether it found food. */
export interface SearchRecord {
  radius: number
  /** When it ended (epoch ms). */
  at: number
  found: boolean
}

/** What keep_fed knows about the bot and its surroundings when choosing the next step. */
export interface FoodWorld {
  /** Ready food in the inventory (not raw meat or raw potato). */
  hasReadyFood: boolean
  /** Raw foods in the inventory that cooking would improve. */
  raw: string[]
  /** Raw foods that are safe to eat uncooked. */
  safeRaw: boolean
  /** Can cook now: smelt action, a furnace (nearby, carried or craftable) and fuel. */
  canCook: boolean
  /** Wheat for at least one bread, and the craft action. */
  canBake: boolean
  /** A known chest with food that the bot may withdraw from. */
  foodChest: boolean
  /** Ripe crops in range it may take: its own farm, a village farm (or any, with anyCrops). */
  ripeCrops: number
  /** Animals in range it may hunt now: adults above the breeders it keeps per kind. */
  animals: number
  /** All huntable adults in range, breeders included (hunted only when starving). */
  herd?: number
  /** Health or food critically low: the breeders are no longer spared. */
  starving?: boolean
  /** Distance to its own farm when that has ripe crops (or is due a visit), else null. */
  farmDistance?: number | null
  /** Distance to the best remembered food spot (animals, village farm), else null. */
  spotDistance?: number | null
  /** Night: no long trips unless scoutAtNight. */
  night?: boolean
  /** The find_food action is there. */
  canScout?: boolean
  /** It has a farm of its own (farm:<n>). */
  hasFarm?: boolean
  /** start_farm is there, digging is allowed and it has seeds or grass to get them from. */
  canStartFarm?: boolean
  // ---- the ladder's extra inputs (all optional: old callers get the old order)
  /** Food bar 0..20. */
  food?: number
  health?: number
  /** Plantable seeds carried (wheat seeds, carrots, potatoes, beetroot seeds). */
  seeds?: number
  /** Grass close by to break for wheat seeds (and the bot may dig). */
  grass?: boolean
  /** Empty farmland on its own farm, in range. */
  farmEmpty?: number
  /** Crops on its own farm that are planted but not ripe yet. */
  farmGrowing?: number
  /** Ripe stopgap food in range (sweet berry bushes). */
  forage?: number
  /** A breeding pair and food for them are at hand. */
  canBreed?: boolean
  /** Hostiles close by: no far trips now. */
  danger?: boolean
  /** Recent find_food runs, newest last. */
  searches?: readonly SearchRecord[]
  /** Steps that failed recently, with the time until which they are left alone (epoch ms). */
  paused?: Partial<Record<FoodStep, number>>
  /** When it last told the owner it is starving (epoch ms). */
  lastReportAt?: number
  /** Clock for the time-based rules (epoch ms); default Date.now(). */
  now?: number
}

export interface FoodStepOptions {
  chests: boolean
  harvest: boolean
  hunt: boolean
  cook: boolean
  eatRaw: boolean
  /** Go and harvest its own farm (default true). */
  farms?: boolean
  /** Go back to remembered food spots (default true). */
  places?: boolean
  /** Scout beyond the radius (default false here; keep_fed's option defaults to true). */
  scout?: boolean
  scoutAtNight?: boolean
  /** The farm fallback: start, fill and use a farm when there is no proper source (default false here). */
  startFarm?: boolean
  /** Beyond this distance a trip counts as far (no far trips at night). */
  radius?: number
  /** Search rings, smallest first (default [48, 120, 250]). */
  rings?: readonly number[]
  /** How long an empty ring is remembered (default 20 minutes). */
  ringMemoryMs?: number
  /** Seeds to have before starting a farm; fewer, with grass near, means gather first (default 8). */
  minSeeds?: number
  /** Spare this many adults of each kind for breeding (default 0 here; keep_fed's default is 2). */
  keepAtLeast?: number
  /** Food at or below this is critical (default 6). */
  critical?: number
  /** At most one starving report per this long (default 10 minutes). */
  reportEveryMs?: number
}

export interface FoodDecision {
  step: FoodStep | null
  rung: FoodRung | null
  /** Why, for the debug log. */
  reason: string
  /** scout: how far out, and the inner radius already covered (rings inside it are skipped). */
  radius?: number
  minRadius?: number
  /** scout: seeds to pick up on the way (breaking grass) so a farm can be started later. */
  seeds?: number
  /** hunt/scout: adults of each kind to spare. */
  keepAtLeast?: number
  /** When no step is left: how long until it is worth trying again. */
  retryMs: number
}

export const DEFAULT_RINGS = [48, 120, 250] as const
export const RING_MEMORY_MS = 20 * 60_000

/**
 * The search ring to try next: the smallest one that no recent empty search covered (an empty
 * 120-block search covers the 48 ring too), with the largest empty radius inside it. Null when
 * every ring came up empty within `memoryMs`.
 */
export function nextRing (searches: readonly SearchRecord[], rings: readonly number[], now: number, memoryMs = RING_MEMORY_MS): { radius: number, covered: number } | null {
  const empty = searches.filter(s => !s.found && now - s.at < memoryMs)
  const covered = empty.reduce((m, s) => Math.max(m, s.radius), 0)
  const ring = [...rings].sort((a, b) => a - b).find(r => r > covered)
  return ring === undefined ? null : { radius: ring, covered }
}

/** Adds a search record and drops the ones older than `keepMs` (and all but the last 12). */
export function recordSearch (searches: readonly SearchRecord[], rec: SearchRecord, keepMs = RING_MEMORY_MS * 3): SearchRecord[] {
  return [...searches.filter(s => rec.at - s.at < keepMs), rec].slice(-12)
}

/** How long a failed step is left alone before the ladder offers it again. */
export const STEP_PAUSE_MS: Record<FoodStep, number> = {
  eat: 60_000,
  cook: 2 * 60_000,
  bread: 60_000,
  withdraw: 10 * 60_000,
  harvest: 2 * 60_000,
  farm: 10 * 60_000,
  spot: 5 * 60_000, // spots also carry their own empty-visit pause
  hunt: 2 * 60_000,
  scout: 0, // the search records decide
  seeds: 10 * 60_000,
  start_farm: 15 * 60_000,
  plant: 10 * 60_000,
  breed: 10 * 60_000,
  forage: 5 * 60_000,
  report: 0
}

/** How long to wait before the next keep_fed run, by what is left to do. */
const RETRY = { soon: 20_000, night: 2 * 60_000, growing: 3 * 60_000, critical: 2 * 60_000, idle: 5 * 60_000 }

/**
 * The next rung and step towards being fed. `tried` holds steps that already failed this run;
 * `w.paused` holds steps that failed in a recent run. Pure: all of the world comes in through
 * `w`, so the order is unit-tested.
 */
export function planFood (w: FoodWorld, o: FoodStepOptions, tried: ReadonlySet<FoodStep> = new Set()): FoodDecision {
  const now = w.now ?? Date.now()
  const ok = (s: FoodStep) => !tried.has(s) && !((w.paused?.[s] ?? 0) > now)
  const far = (d: number) => o.radius !== undefined && d > o.radius
  const dayOrBold = !w.night || !!o.scoutAtNight
  const mayGo = (d: number) => (!far(d) || dayOrBold) && (!far(d) || !w.danger)
  const huntable = w.animals > 0 || (!!w.starving && (w.herd ?? 0) > 0)
  const keep = w.starving ? 0 : (o.keepAtLeast ?? 0)
  const critical = (w.food ?? 20) <= (o.critical ?? 6)
  const d = (step: FoodStep, rung: FoodRung, reason: string, extra: Partial<FoodDecision> = {}): FoodDecision => ({ step, rung, reason, retryMs: RETRY.soon, ...extra })

  // 1. what it carries
  if (w.hasReadyFood && ok('eat')) return d('eat', 'inventory', 'ready food in the bag')
  if (o.cook && w.raw.length && w.canCook && ok('cook')) return d('cook', 'inventory', `raw ${w.raw.join(', ')} and a furnace with fuel`)
  if (w.canBake && ok('bread')) return d('bread', 'inventory', '3+ wheat')
  if (o.eatRaw && w.safeRaw && ok('eat')) return d('eat', 'inventory', `can't cook, eating raw ${w.raw.join(', ')}`)

  // 2. sources it knows
  if (o.chests && w.foodChest && ok('withdraw')) return d('withdraw', 'known', 'food in a known chest')
  if (o.harvest && w.ripeCrops > 0 && ok('harvest')) return d('harvest', 'known', `${w.ripeCrops} ripe crops in range`)
  if (o.harvest && o.farms !== false && w.farmDistance != null && mayGo(w.farmDistance) && ok('farm')) return d('farm', 'known', `own farm ${w.farmDistance} blocks away is ripe or due a visit`)
  // a spot counts only when we are not standing at it already (within 16 blocks the hunt/harvest steps see it)
  if (o.places !== false && w.spotDistance != null && w.spotDistance > 16 && mayGo(w.spotDistance) && (!huntable || !far(w.spotDistance)) && ok('spot')) {
    return d('spot', 'known', `remembered food spot ${w.spotDistance} blocks away`)
  }
  if (o.hunt && huntable && ok('hunt')) {
    return d('hunt', 'known', w.animals > 0 ? `${w.animals} animals to spare in range` : `starving, hunting the breeders too (${w.herd})`, { keepAtLeast: keep })
  }

  // 3. search, one ring wider than the last empty one
  const fallback = !!o.startFarm
  const seeds = w.seeds ?? 0
  const minSeeds = o.minSeeds ?? 8
  const rings = o.rings?.length ? o.rings : DEFAULT_RINGS
  const ring = nextRing(w.searches ?? [], rings, now, o.ringMemoryMs ?? RING_MEMORY_MS)
  let searchBlocked = ''
  if (!o.scout || !w.canScout) searchBlocked = 'scouting is off'
  else if (!dayOrBold) searchBlocked = 'night'
  else if (w.danger) searchBlocked = 'hostiles near'
  else if (!ring) searchBlocked = `every ring out to ${Math.max(...rings)} came up empty in the last ${Math.round((o.ringMemoryMs ?? RING_MEMORY_MS) / 60_000)} min`
  else if (!ok('scout')) searchBlocked = 'already scouted this run'
  if (!searchBlocked && ring) {
    const pick = fallback && w.seeds !== undefined && seeds < minSeeds ? minSeeds - seeds : 0
    return d('scout', 'search', ring.covered ? `nothing within ${ring.covered} blocks, widening to ${ring.radius}` : `nothing in range, searching ${ring.radius} blocks out`,
      { radius: ring.radius, minRadius: ring.covered, keepAtLeast: keep, ...(pick ? { seeds: pick } : {}) })
  }

  // 5. no proper source: grow food (and use stopgaps while it grows)
  const farmWhy = `no proper food source (${searchBlocked})`
  if (fallback) {
    if (critical && (w.forage ?? 0) > 0 && ok('forage')) return d('forage', 'farm', `food ${w.food}/20, berries in range while nothing else works`)
    if (w.hasFarm && (w.farmEmpty ?? 0) > 0 && seeds > 0 && ok('plant')) return d('plant', 'farm', `${farmWhy}; ${w.farmEmpty} empty farmland on its farm and ${seeds} seeds`)
    if (dayOrBold && w.grass && ok('seeds') && ((w.hasFarm && (w.farmEmpty ?? 0) > seeds) || (!w.hasFarm && w.canStartFarm && w.seeds !== undefined && seeds < minSeeds))) {
      return d('seeds', 'farm', `${farmWhy}; ${seeds} seeds, breaking grass for more`)
    }
    if (!w.hasFarm && w.canStartFarm && dayOrBold && ok('start_farm')) return d('start_farm', 'farm', `${farmWhy}; ${seeds} seeds, starting a farm`)
    if (w.canBreed && ok('breed')) return d('breed', 'farm', `${farmWhy}; breeding animals for later`)
    if ((w.forage ?? 0) > 0 && ok('forage')) return d('forage', 'farm', `${farmWhy}; berries as a stopgap`)
  }

  // 6. critical and nothing works: say so once, stay safe
  if (critical && ok('report') && now - (w.lastReportAt ?? 0) >= (o.reportEveryMs ?? 10 * 60_000)) {
    return d('report', 'critical', `food ${w.food}/20 and nothing left to try (${searchBlocked})`, { retryMs: RETRY.critical })
  }

  // nothing now: when to look again
  let retryMs = RETRY.idle
  let why = searchBlocked ? `nothing to do (${searchBlocked})` : 'nothing to do'
  if (ring && dayOrBold && !w.danger && o.scout && w.canScout) retryMs = RETRY.soon // a wider ring is still open
  else if (w.night && !o.scoutAtNight) { retryMs = RETRY.night; why += ', waiting for day' }
  else if (w.hasFarm && (w.farmGrowing ?? 0) > 0) { retryMs = RETRY.growing; why += `, ${w.farmGrowing} crops growing` }
  else if (critical) retryMs = RETRY.critical
  return { step: null, rung: null, reason: why, retryMs }
}

/** The next step only (planFood's step). */
export function nextFoodStep (w: FoodWorld, o: FoodStepOptions, tried: ReadonlySet<FoodStep> = new Set()): FoodStep | null {
  return planFood(w, o, tried).step
}
