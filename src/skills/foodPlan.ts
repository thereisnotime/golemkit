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
  | 'other' // sand, stone, a tree, a hole, a step up or down, a cell under a roof
  | 'hazard' // lava or ice close by: burns, or the water freezes

export interface SiteCandidate {
  /** The water block the plot is laid around. */
  water: Pos
  /** Kinds of the cells in the plot square (size x size, centre included), keyed "dx,dz". */
  cells: Record<string, CellKind>
  /** Kinds found in a ring of `margin` blocks around the square (builds nearby rule a site out). */
  around: CellKind[]
  /** Distance from where the farm should be (home, a place, the bot). */
  distance: number
  /** The first placed block that made it 'build' ("oak_planks at 1 2 3"), for the reason text. */
  buildNote?: string
}

/** The bot's own work, which never counts as somebody's build near a farm site (farming.ownBuilds). */
export interface OwnWork {
  /** Blocks it placed for builds ("x,y,z", build.own). */
  blocks?: readonly string[]
  /** Torches it put up (lighting.torches). */
  torches?: readonly Pos[]
  /** Structures it finished (build.placements boxes). */
  boxes?: readonly { min: Pos, max: Pos }[]
  /** Its farms, healthy or bad: the farmland, fences, torches and covers in and around them. */
  farms?: readonly { x: number, z: number, size?: number }[]
  /** Its base (base projects' anchor) and how far around it counts as its own. */
  base?: { x: number, z: number, radius: number } | null
}

/** A test for "this block is the bot's own work". Pure. */
export function ownWorkTest (o: OwnWork): (p: Pos) => boolean {
  const blocks = new Set(o.blocks ?? [])
  const torches = new Set((o.torches ?? []).map(t => `${t.x},${t.y},${t.z}`))
  return (p: Pos) => {
    const k = `${p.x},${p.y},${p.z}`
    if (blocks.has(k) || torches.has(k)) return true
    if ((o.boxes ?? []).some(b => p.x >= b.min.x - 1 && p.x <= b.max.x + 1 && p.z >= b.min.z - 1 && p.z <= b.max.z + 1 && p.y >= b.min.y - 1 && p.y <= b.max.y + 4)) return true
    // a farm's square plus its fence ring and the torches on it
    if ((o.farms ?? []).some(f => Math.max(Math.abs(p.x - f.x), Math.abs(p.z - f.z)) <= ((f.size ?? 9) - 1) / 2 + 2)) return true
    return !!o.base && Math.max(Math.abs(p.x - o.base.x), Math.abs(p.z - o.base.z)) <= o.base.radius
  }
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
  if (kinds.includes('hazard') || c.around.includes('hazard')) return null
  if (!r.allowFarmland && (kinds.includes('farmland') || c.around.includes('farmland'))) return null
  const land = Object.entries(c.cells).filter(([k]) => k !== '0,0')
  const till = land.filter(([, v]) => v === 'tillable').length
  if (!land.length || till < r.minTillable) return null
  // more tillable cells, fewer extra water holes, closer is better
  const water = land.filter(([, v]) => v === 'water').length
  return till - water * 0.5 - c.distance / 8
}

/** Why a site can't be used ("4 tillable cells, 8 needed"), or null when it can. Same rules as scoreSite. */
export function siteProblem (c: SiteCandidate, rules: Partial<SiteRules> = {}): string | null {
  const r: SiteRules = { minTillable: 8, allowFarmland: false, ...rules }
  const kinds = Object.values(c.cells)
  if (kinds.includes('protected') || c.around.includes('protected')) return 'protected'
  if (kinds.includes('build') || c.around.includes('build')) return `somebody's build${c.buildNote ? ` (${c.buildNote})` : ''}`
  if (kinds.includes('hazard') || c.around.includes('hazard')) return 'lava, powder snow or ice close'
  if (!r.allowFarmland && (kinds.includes('farmland') || c.around.includes('farmland'))) return 'a field there'
  const till = Object.entries(c.cells).filter(([k, v]) => k !== '0,0' && v === 'tillable').length
  if (till < r.minTillable) return `${till} tillable cells, ${r.minTillable} needed`
  return null
}

/** What ruled the candidates out, most common first: "12 x 3 tillable cells, 8 needed; 4 x protected". */
export function siteProblems (cands: readonly SiteCandidate[], rules: Partial<SiteRules> = {}, top = 3): string {
  const n = new Map<string, number>()
  for (const c of cands) {
    let why = siteProblem(c, rules)
    if (!why) continue
    if (/tillable cells/.test(why)) why = `under ${rules.minTillable ?? 8} tillable cells`
    if (why.startsWith('somebody\'s build') && n.has('somebody\'s build')) why = 'somebody\'s build'
    else if (why.startsWith('somebody\'s build') && [...n.keys()].some(k => k.startsWith('somebody\'s build'))) why = [...n.keys()].find(k => k.startsWith('somebody\'s build'))!
    n.set(why, (n.get(why) ?? 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, top).map(([w, k]) => `${k} ${w}`).join(', ')
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
 *   search:    scout (find_food) one ring wider than the last empty one (rings beyond 250 by day only;
 *              rings beyond 48 with poor gear only when food is 8 or less: riskyRing)
 *   trip:      walk to a known farm or village far away, harvest, bake, eat, come back
 *              (before the far rings, and when every ring is empty)
 *   farm:      plant (fill its farm), seeds (break grass), start_farm, breed, forage (stopgap)
 *   critical:  report (tell the owner once, stay safe)
 */
export type FoodStep =
  | 'eat' | 'cook' | 'bread' | 'withdraw' | 'harvest' | 'farm' | 'spot' | 'hunt'
  | 'scout' | 'trip' | 'seeds' | 'start_farm' | 'plant' | 'breed' | 'forage' | 'report'
  | 'fish' | 'eat_rotten'

export type FoodRung = 'inventory' | 'known' | 'search' | 'trip' | 'farm' | 'critical'

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
  /** Seeds it saw in its own and configured chests near home (gather_seeds takes those first). */
  chestSeeds?: number
  /** Empty farmland on its own farm, in range. */
  farmEmpty?: number
  /** Crops on its own farm that are planted but not ripe yet. */
  farmGrowing?: number
  /** Ripe stopgap food in range: sweet berry bushes, and kelp at the shore when it can smelt it. */
  forage?: number
  /** Natural oak / dark oak leaves in reach (apples, about 1 in 200): only tried when critical. */
  apples?: number
  /** Work its farm needs that it can do now (plant, re-till, grow, put water back), from planFarmWork. */
  farmWork?: number
  /** Seeds it lacks to plant, re-till and grow its farm to the target size (and keep the reserve). */
  farmSeedsWanted?: number
  /** A breeding pair and food for them are at hand. */
  canBreed?: boolean
  /** Hostiles close by: no far trips now. */
  danger?: boolean
  /** Its gear score against mobs (gearScore: armour, shield, weapon, bow, health; 0-100). Unknown: no gear rule. */
  gear?: number
  /** Recent find_food runs, newest last. */
  searches?: readonly SearchRecord[]
  /** Steps that failed recently, with the time until which they are left alone (epoch ms). */
  paused?: Partial<Record<FoodStep, number>>
  /** When it last told the owner it is starving (epoch ms). */
  lastReportAt?: number
  /** The best known food place worth a trip (rankFoodPlaces' first), or null. */
  knownPlace?: { name: string, distance: number } | null
  /** Rotten flesh carried: eaten only when food is at or below eatRottenAt and nothing better is at hand. */
  rotten?: number
  /** Wheat in containers it may take from (with what it carries, 3 make a bread). */
  chestWheat?: number
  /** Wheat carried. */
  carriedWheat?: number
  /** Distance to a shore spot by open water near home when it has or can get a fishing rod, else null. */
  fishDistance?: number | null
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
  /** Search rings, smallest first (default [48, 120, 250, 400, 600]). */
  rings?: readonly number[]
  /** Rings wider than this are far: searched by day only, even with scoutAtNight, and a known place comes first (default 250). */
  farRingsFrom?: number
  /** Rings wider than this are risky trips: with gear under scoutGear only when food is at or below scoutHungerAt (default 48). */
  riskyRingsFrom?: number
  /** Gear score (gearScore) from which risky rings are fine whatever the food (default 40; 0 turns the gear rule off). */
  scoutGear?: number
  /** Food at or below this makes risky rings worth it even with poor gear (default 8). */
  scoutHungerAt?: number
  /** At or below this food no risky ring is started at all, whatever the gear (default 6). */
  scoutFoodFloor?: number
  /** Trips to known food places (default true; without a knownPlace there is nothing to go to anyway). */
  trips?: boolean
  /** How long an empty ring is remembered (default 3 hours, RING_MEMORY_MS). */
  ringMemoryMs?: number
  /** Seeds to have before starting a farm; fewer, with grass near, means gather first (default 8). */
  minSeeds?: number
  /** Tend, grow or start its farm alongside the other sources when food is at least farmAbove (default: with startFarm). */
  growFarm?: boolean
  /** Food at or above this is not urgent: farm work may come before searching (default 14). */
  farmAbove?: number
  /** Spare this many adults of each kind for breeding (default 0 here; keep_fed's default is 2). */
  keepAtLeast?: number
  /** Food at or below this is critical (default 6). */
  critical?: number
  /** At most one starving report per this long (default 10 minutes). */
  reportEveryMs?: number
  /** Fish at open water near home when it has or can make a rod (default false here; keep_fed's option defaults to true). */
  fish?: boolean
  /** Food at or below this with no other food at hand: eat rotten flesh (default 0 here = never; keep_fed's default is 6). */
  eatRottenAt?: number
  /** Food at or below `critical`: its farm, remembered spots and known places further than this are skipped for the closest sure food (default: no limit here; keep_fed's default is 96). */
  starvingRange?: number
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
  /** forage: also break leaves for apples (critical only). */
  apples?: boolean
  /** When no step is left: how long until it is worth trying again. */
  retryMs: number
}

export const DEFAULT_RINGS = [48, 120, 250, 400, 600] as const
/** Rings beyond this are far ones (day only, after known places). */
export const FAR_RINGS_FROM = 250
/** How long an empty ring stays empty: animals don't move into a snowy spruce forest within minutes, and every scout costs food. */
export const RING_MEMORY_MS = 3 * 3600_000
/** Rings wider than this take the bot far from home: with poor gear only when hungry enough. */
export const RISKY_RINGS_FROM = 48
/** Gear score from which a far ring is fine at any food level (stone tools and no armour score about 25; iron armour and a sword about 50; a shield adds 20). */
export const SCOUT_GEAR = 40
/** Food at or below this makes a far ring worth it whatever the gear. */
export const SCOUT_HUNGER_AT = 8
/** At or below this food a far ring is never started: the walk out and back eats what is left, and at 0 health drains (Pax, 23 Nov 2026: food 12 to 0 in 6 minutes of scouting, then shot at 1 health and drowned). */
export const SCOUT_FOOD_FLOOR = 6
/** At most one "can't find food" report per this long. */
export const REPORT_EVERY_MS = 60 * 60_000

/**
 * Why a search ring is too risky for now, or null: a ring wider than riskyRingsFrom, a gear score
 * under scoutGear and food above scoutHungerAt (not urgent yet), or food at or below scoutFoodFloor
 * whatever the gear (the trip itself would starve it). Unknown gear skips the gear part. Seen live: Pax at food 12 with stone tools and no armour scouted 120 blocks out
 * and died to three skeletons, with crops growing on its farm at home.
 */
export function riskyRing (ring: number, w: Pick<FoodWorld, 'gear' | 'food' | 'starving'>, o: Pick<FoodStepOptions, 'riskyRingsFrom' | 'scoutGear' | 'scoutHungerAt' | 'scoutFoodFloor'> = {}): string | null {
  if (ring <= (o.riskyRingsFrom ?? RISKY_RINGS_FROM)) return null
  const food = w.food ?? 20
  const floor = o.scoutFoodFloor ?? SCOUT_FOOD_FLOOR
  if (w.food !== undefined && food <= floor) return `food ${food}/20 is too low to walk ${ring} blocks out and back (the trip would eat the rest)`
  const wanted = o.scoutGear ?? SCOUT_GEAR
  if (w.gear === undefined || wanted <= 0 || w.starving) return null
  if (food <= (o.scoutHungerAt ?? SCOUT_HUNGER_AT) || w.gear >= wanted) return null
  return `food ${food}/20 is not urgent and gear ${Math.round(w.gear)} is under ${wanted}: not scouting ${ring} blocks out yet`
}

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
  spot: 0, // each spot carries its own empty-visit pause (a new sighting must not wait)
  hunt: 2 * 60_000,
  scout: 0, // the search records decide
  trip: 0, // each place carries its own pause (TRIP_PAUSE_MS)
  seeds: 10 * 60_000,
  start_farm: 15 * 60_000,
  plant: 10 * 60_000,
  breed: 10 * 60_000,
  forage: 5 * 60_000,
  report: 0,
  fish: 10 * 60_000,
  eat_rotten: 60_000
}

/** How long to wait before the next keep_fed run, by what is left to do. */
const RETRY = { soon: 20_000, danger: 45_000, night: 2 * 60_000, growing: 3 * 60_000, critical: 2 * 60_000, idle: 5 * 60_000 }

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
  const critical = (w.food ?? 20) <= (o.critical ?? 6)
  // starving at night: its own farm, a chest or a spot close to home is worth the dark (starving is certain harm, the dark only likely)
  const nearRing = o.riskyRingsFrom ?? RISKY_RINGS_FROM
  // starving: the closest sure food, not a long walk that eats the rest (Pax, 28 Nov 2026: food 6, set off for a village 3500 blocks away)
  const close = (d: number) => !critical || o.starvingRange === undefined || d <= o.starvingRange
  const mayGo = (d: number) => (!far(d) || dayOrBold || (critical && d <= nearRing * 2)) && (!far(d) || !w.danger) && close(d)
  const fishNow = !!o.fish && w.fishDistance != null && (dayOrBold || critical) && !w.danger && close(w.fishDistance)
  const huntable = w.animals > 0 || (!!w.starving && (w.herd ?? 0) > 0)
  const keep = w.starving ? 0 : (o.keepAtLeast ?? 0)
  const seeds = w.seeds ?? 0
  const minSeeds = o.minSeeds ?? 8
  const fallback = !!o.startFarm
  // farm work it can do now: planFarmWork's count when known, else bare farmland it has seeds for
  const work = w.farmWork !== undefined ? w.farmWork : (seeds > 0 ? (w.farmEmpty ?? 0) : 0)
  const forageNow = (w.forage ?? 0) > 0 || (critical && (w.apples ?? 0) > 0)
  const d = (step: FoodStep, rung: FoodRung, reason: string, extra: Partial<FoodDecision> = {}): FoodDecision => ({ step, rung, reason, retryMs: RETRY.soon, ...extra })

  // 1. what it carries
  if (w.hasReadyFood && ok('eat')) return d('eat', 'inventory', 'ready food in the bag')
  if (o.cook && w.raw.length && w.canCook && ok('cook')) return d('cook', 'inventory', `raw ${w.raw.join(', ')} and a furnace with fuel`)
  if (w.canBake && ok('bread')) return d('bread', 'inventory', '3+ wheat')
  if (o.eatRaw && w.safeRaw && ok('eat')) return d('eat', 'inventory', `can't cook, eating raw ${w.raw.join(', ')}`)
  // starving with nothing else in the bag: rotten flesh feeds (4 points, a short hunger effect) and buys time to get real food
  if ((w.rotten ?? 0) > 0 && (w.food ?? 20) <= (o.eatRottenAt ?? 0) && ok('eat_rotten')) return d('eat_rotten', 'inventory', `food ${w.food}/20 and nothing better carried: rotten flesh`)

  // 2. sources it knows
  if (o.chests && w.foodChest && ok('withdraw')) return d('withdraw', 'known', 'food in a known chest')
  if (o.chests && (w.chestWheat ?? 0) > 0 && !w.canBake && (w.chestWheat ?? 0) + (w.carriedWheat ?? 0) >= 3 && ok('bread')) return d('bread', 'known', `${w.chestWheat} wheat in its chests: taking it to bake bread`)
  if (o.harvest && w.ripeCrops > 0 && ok('harvest')) return d('harvest', 'known', `${w.ripeCrops} ripe crops in range`)
  if (o.harvest && o.farms !== false && w.farmDistance != null && mayGo(w.farmDistance) && ok('farm')) return d('farm', 'known', `own farm ${w.farmDistance} blocks away is ripe or due a visit`)
  // a spot counts only when we are not standing at it already (within 16 blocks the hunt/harvest steps see it)
  if (o.places !== false && w.spotDistance != null && w.spotDistance > 16 && mayGo(w.spotDistance) && (!huntable || !far(w.spotDistance)) && ok('spot')) {
    return d('spot', 'known', `remembered food spot ${w.spotDistance} blocks away`)
  }
  if (o.hunt && huntable && ok('hunt')) {
    return d('hunt', 'known', w.animals > 0 ? `${w.animals} animals to spare in range` : `starving, hunting the breeders too (${w.herd})`, { keepAtLeast: keep })
  }
  if (fishNow && ok('fish')) return d('fish', 'known', `open water ${Math.round(w.fishDistance!)} blocks away and a rod: fishing`)

  // 2b. not urgent: a farm is long-term food, so tend, grow or start it before a long search
  const food = w.food ?? 0
  if (fallback && o.growFarm !== false && food >= (o.farmAbove ?? 14) && !w.starving && dayOrBold && !w.danger) {
    if (w.hasFarm && work > 0 && ok('plant')) return d('plant', 'farm', `food ${food}/20 is not urgent: tending its farm first (${work} cells to plant, re-till or grow)`)
    if (!w.hasFarm && w.canStartFarm && seeds >= minSeeds && ok('start_farm')) return d('start_farm', 'farm', `food ${food}/20 is not urgent and it has ${seeds} seeds: starting a farm alongside`)
  }

  // 3. search, one ring wider than the last empty one. Rings past farRingsFrom are far: by day
  // only (even with scoutAtNight), and a known farm or village is visited first.
  const rings = o.rings?.length ? o.rings : DEFAULT_RINGS
  const farFrom = o.farRingsFrom ?? FAR_RINGS_FROM
  const ring = nextRing(w.searches ?? [], rings, now, o.ringMemoryMs ?? RING_MEMORY_MS)
  const farRing = !!ring && ring.radius > farFrom
  const place = o.trips !== false && w.knownPlace && !w.night && !w.danger && close(w.knownPlace.distance) && ok('trip') ? w.knownPlace : null
  const trip = () => d('trip', 'trip', `${ring ? `before searching ${ring.radius} blocks out` : 'every ring came up empty'}: known food place ${place!.name} ${Math.round(place!.distance)} blocks away`)
  let searchBlocked = ''
  if (!o.scout || !w.canScout) searchBlocked = 'scouting is off'
  else if ((!dayOrBold && !(critical && ring && ring.radius <= nearRing)) || (farRing && w.night)) searchBlocked = farRing && dayOrBold ? `night: the ${ring!.radius} ring is searched by day only` : 'night or a storm'
  else if (w.danger) searchBlocked = 'hostiles near'
  else if (!ring) searchBlocked = `every ring out to ${Math.max(...rings)} came up empty in the last ${Math.round((o.ringMemoryMs ?? RING_MEMORY_MS) / 60_000)} min`
  else if (!ok('scout')) searchBlocked = 'already scouted this run'
  const risky = !searchBlocked && ring ? riskyRing(ring.radius, w, o) : null
  if (risky) searchBlocked = risky
  if (!searchBlocked && ring) {
    if (farRing && place) return trip()
    const pick = fallback && w.seeds !== undefined && seeds < minSeeds ? minSeeds - seeds : 0
    return d('scout', 'search', ring.covered ? `nothing within ${ring.covered} blocks, widening to ${ring.radius}` : `nothing in range, searching ${ring.radius} blocks out`,
      { radius: ring.radius, minRadius: ring.covered, keepAtLeast: keep, ...(pick ? { seeds: pick } : {}) })
  }

  // 4. every ring empty (or the search is blocked): a known farm or village further away is real food
  if (place && (!ring || farRing)) return trip()

  // 5. no proper source: grow food (and use stopgaps while it grows). A search that just found
  // food is a source: the next run goes back to it instead of farming.
  const justFound = (w.searches ?? []).some(s => s.found && now - s.at < 10 * 60_000)
  const farmWhy = `no proper food source (${searchBlocked})`
  if (fallback && !(justFound && ring)) {
    if (critical && forageNow && ok('forage')) return d('forage', 'farm', `food ${w.food}/20, ${(w.forage ?? 0) > 0 ? 'berries or kelp' : 'leaves for apples'} in range while nothing else works`, { apples: (w.apples ?? 0) > 0 })
    if (w.hasFarm && work > 0 && ok('plant')) return d('plant', 'farm', `${farmWhy}; ${work} cells on its farm to plant, re-till or grow, ${seeds} seeds`)
    const farmShort = (w.farmEmpty ?? 0) > seeds || (w.farmSeedsWanted ?? 0) > 0
    if (dayOrBold && (w.grass || (w.chestSeeds ?? 0) > 0) && ok('seeds') && ((w.hasFarm && farmShort) || (!w.hasFarm && w.canStartFarm && w.seeds !== undefined && seeds < minSeeds))) {
      return d('seeds', 'farm', `${farmWhy}; ${seeds} seeds, breaking grass for more`)
    }
    if (!w.hasFarm && w.canStartFarm && dayOrBold && ok('start_farm')) return d('start_farm', 'farm', `${farmWhy}; ${seeds} seeds, starting a farm`)
    if (w.canBreed && ok('breed')) return d('breed', 'farm', `${farmWhy}; breeding animals for later`)
    if (forageNow && ok('forage')) return d('forage', 'farm', `${farmWhy}; ${(w.forage ?? 0) > 0 ? 'berries or kelp' : 'apples from leaves'} as a stopgap`, critical && (w.apples ?? 0) > 0 ? { apples: true } : {})
  }

  // 6. critical, or every ring came up empty, and nothing works: tell the owner (once an hour), stay safe
  const searchedTo = (w.searches ?? []).filter(s => !s.found && now - s.at < (o.ringMemoryMs ?? RING_MEMORY_MS)).reduce((m, s) => Math.max(m, s.radius), 0)
  // (not when a farm was just started or is growing: that is food on its way)
  const nothingFound = !ring && !tried.has('start_farm') && !(w.hasFarm && (w.farmGrowing ?? 0) > 0)
  if ((critical || nothingFound) && ok('report') && now - (w.lastReportAt ?? 0) >= (o.reportEveryMs ?? REPORT_EVERY_MS)) {
    return d('report', 'critical', `food ${w.food ?? '?'}/20, nothing left to try: ${searchBlocked}`, { retryMs: RETRY.critical, ...(searchedTo ? { radius: searchedTo } : {}) })
  }

  // nothing now: when to look again
  let retryMs = RETRY.idle
  let why = searchBlocked ? `nothing to do (${searchBlocked})` : 'nothing to do'
  if (ring && dayOrBold && !(farRing && w.night) && !w.danger && o.scout && w.canScout && !risky) retryMs = RETRY.soon // a wider ring is still open
  else if (w.night && (!o.scoutAtNight || farRing || !!w.knownPlace)) { retryMs = RETRY.night; why += ', waiting for day' }
  else if (w.danger) { retryMs = RETRY.danger; why += ', waiting for the mobs to go' }
  else if (w.hasFarm && (w.farmGrowing ?? 0) > 0) { retryMs = RETRY.growing; why += `, ${w.farmGrowing} crops growing` }
  else if (risky) retryMs = RETRY.growing // food drops slowly: look again in a few minutes
  else if (critical) retryMs = RETRY.critical
  return { step: null, rung: null, reason: why, retryMs }
}

/**
 * What keep_fed tells its owner when it can't find food: how far it looked and what would help,
 * once an hour at most (Pax looped scouting a snowy spruce forest with no animals, no seeds and the
 * only village 3000 blocks away).
 */
export function foodReportText (s: { food: number, searchedTo?: number, seeds: number, hasFarm: boolean, reason: string }): string {
  const where = s.searchedTo ? `nothing to eat within ${s.searchedTo} blocks of home` : "can't find anything to eat"
  const want = ['food', s.hasFarm && s.seeds < 4 ? 'seeds for my farm' : !s.hasFarm ? 'seeds to start a farm' : '', 'or a pair of animals to breed'].filter(Boolean).join(', ')
  const reason = s.reason.replace(/^food \d+\/20, nothing left to try: /, '')
  return `I'm ${s.food <= 6 ? 'starving' : 'hungry'} (food ${s.food}/20) and ${where} (${reason}). Staying safe near home; ${want} would help.`
}

/** The next step only (planFood's step). */
export function nextFoodStep (w: FoodWorld, o: FoodStepOptions, tried: ReadonlySet<FoodStep> = new Set()): FoodStep | null {
  return planFood(w, o, tried).step
}

// ------------------------------------------------------------------ danger

/**
 * The straight way from `from` to `to` passes a point for which `inZone` is true (sampled
 * every `step` blocks, both ends included).
 */
export function crossesDanger (from: XZ, to: XZ, inZone: (p: XZ) => boolean, step = 8): boolean {
  const len = Math.hypot(to.x - from.x, to.z - from.z)
  const n = Math.max(1, Math.ceil(len / Math.max(1, step)))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (inZone({ x: Math.round(from.x + (to.x - from.x) * t), z: Math.round(from.z + (to.z - from.z) * t) })) return true
  }
  return false
}

/**
 * keep_fed's danger signal, the same ones stay_safe acts on: shooters calling for cover
 * (stay_safe's `ranged`), being surrounded (3+ hostiles within 6), hostiles close while
 * badly hurt, or standing in a remembered danger zone.
 */
export function foodDanger (s: { ranged: boolean, close: number, near: number, health: number, inZone: boolean, surroundedBy?: number }): string | null {
  if (s.ranged) return 'shooters around'
  if (s.close >= (s.surroundedBy ?? 3)) return `${s.close} hostiles close`
  if (s.near > 0 && s.health <= 8) return `hurt (${Math.round(s.health)}/20) with mobs near`
  if (s.inZone) return 'in a remembered danger zone'
  return null
}

// ------------------------------------------------------------------ chores when not hungry

export type FoodChore = 'tend_farm' | 'start_farm' | 'seeds' | 'breed'

export interface ChoreWorld {
  food: number
  night: boolean
  danger: boolean
  hasFarm: boolean
  /** start_farm is there and it may dig. */
  canStartFarm: boolean
  seeds: number
  /** Grass close by to break for seeds (and gather_seeds is there). */
  grass: boolean
  /** Seeds it saw in its own and configured chests near home (gather_seeds takes those before breaking grass). */
  chestSeeds?: number
  /** Distance to its nearest farm, or null. */
  farmDistance: number | null
  /** Farm work it can do now (planFarmWork's count), when the farm is loaded. */
  farmWork: number
  /** Seeds short for the farm's work and reserve. */
  farmSeedsWanted: number
  /** Side of the square its farmland covers, and the target. */
  farmSize: number
  farmTarget: number
  /** A breeding pair near home and food for them. */
  canBreed: boolean
  /** Chores that ran recently, with the time until which they are left alone. */
  paused?: Partial<Record<FoodChore, number>>
  now?: number
}

export interface ChoreOptions {
  /** Farm work between meals (default true). */
  growFarm: boolean
  startFarm: boolean
  breed: boolean
  minSeeds: number
  /** Below this food it is keep_fed's ladder, not a chore (default 14). */
  farmAbove: number
  /** Only walk to the farm from this close (default 128). */
  tendRange: number
  /** Seeds kept back for replanting (default 4): a full, planted farm doesn't walk for these. */
  seedReserve?: number
}

/** How long a chore is left alone after it ran (ok) or failed. */
export const CHORE_PAUSE_MS: Record<FoodChore, { ok: number, fail: number }> = {
  tend_farm: { ok: 4 * 60_000, fail: 15 * 60_000 },
  start_farm: { ok: 5 * 60_000, fail: 20 * 60_000 },
  seeds: { ok: 8 * 60_000, fail: 20 * 60_000 },
  breed: { ok: 6 * 60_000, fail: 15 * 60_000 }
}
/** A seeds run that came back short while breakable grass is still around: try again soon (seeds drop 1 in 8, a short run is bad luck). */
export const SEEDS_RETRY_MS = 3 * 60_000

/**
 * How long to leave a chore alone after it ran. A failed seeds run with breakable grass still
 * in reach is paused only briefly: with a 1 in 8 drop, coming back empty is mostly luck.
 */
export function chorePause (chore: FoodChore, ok: boolean, o: { grassLeft?: boolean } = {}): number {
  const p = CHORE_PAUSE_MS[chore]
  if (ok) return p.ok
  if (chore === 'seeds' && o.grassLeft) return SEEDS_RETRY_MS
  return p.fail
}

/**
 * Food work to do between meals, or null: tend and grow its farm when there is work it can do,
 * break grass when the farm is small and short of seeds, start a farm once it has the seeds
 * (even while animals are around: a farm is long-term food), breed animals near home. Never
 * at night, in danger or while hungry (the ladder's turn).
 */
export function farmChore (w: ChoreWorld, o: ChoreOptions): { chore: FoodChore, reason: string } | null {
  const now = w.now ?? Date.now()
  const ok = (c: FoodChore) => !((w.paused?.[c] ?? 0) > now)
  if (w.night || w.danger || w.food < o.farmAbove) return null
  if (o.growFarm && o.startFarm) {
    if (w.hasFarm && w.farmDistance !== null && w.farmDistance <= o.tendRange) {
      if (w.farmWork > 0 && ok('tend_farm')) return { chore: 'tend_farm', reason: `${w.farmWork} cells to plant, re-till or grow (${w.farmSize}x${w.farmSize} of ${w.farmTarget}x${w.farmTarget})` }
      // seeds for empty cells inside the farm as well as for growing it: a farm can span its full size with
      // only a few cells planted, and with no seeds the plan shows no work at all
      // seedsWanted = cells to fill + reserve - seeds; above the reserve means cells it has no seeds for
      // (with seeds in hand, tend_farm would already have planted them)
      const emptyCells = w.farmSeedsWanted > (o.seedReserve ?? 4)
      if (w.farmSeedsWanted > 0 && (w.farmSize < w.farmTarget || emptyCells) && (w.grass || (w.chestSeeds ?? 0) > 0) && ok('seeds')) return { chore: 'seeds', reason: `farm ${w.farmSize}x${w.farmSize} (target ${w.farmTarget}x${w.farmTarget}) is ${w.farmSeedsWanted} seeds short, ${w.seeds} in hand${w.chestSeeds ? `, ${w.chestSeeds} in my chests` : ''}` }
    }
    if (!w.hasFarm && w.canStartFarm) {
      if (w.seeds >= o.minSeeds && ok('start_farm')) return { chore: 'start_farm', reason: `no farm yet and ${w.seeds} seeds` }
      if ((w.grass || (w.chestSeeds ?? 0) > 0) && ok('seeds')) return { chore: 'seeds', reason: `no farm yet, ${w.seeds} of ${o.minSeeds} seeds${w.chestSeeds ? `, ${w.chestSeeds} in my chests` : ''}` }
    }
  }
  if (o.breed && w.canBreed && ok('breed')) return { chore: 'breed', reason: 'a pair near home and food for them' }
  return null
}

// ------------------------------------------------------------------ seed gathering

export interface SeedProgress {
  /** Seeds picked up so far, and how many are wanted. */
  got: number
  want: number
  broken: number
  elapsedMs: number
  /** Breakable grass still in range (not protected, not skipped). */
  grassLeft: boolean
  /** Grass blocks in a row it couldn't reach or break. */
  failsInRow: number
}

export interface SeedLimits {
  maxMs: number
  maxBroken: number
  maxFailsInRow: number
}

/** Grass to break at most for `want` seeds: about 8 per seed, with room for bad luck. */
export function seedBreakBudget (want: number): number {
  return Math.max(48, Math.min(400, Math.ceil(want) * 24))
}

export function seedLimits (want: number, maxMs = 4 * 60_000): SeedLimits {
  return { maxMs, maxBroken: seedBreakBudget(want), maxFailsInRow: 12 }
}

/**
 * Why gather_seeds should stop now, or null to keep breaking grass. It stops when it has the
 * seeds it wants, when time runs out, when the grass in range runs out, at the break budget, or
 * when grass keeps being out of reach. A few broken blocks with no seed is no reason to stop.
 */
export function seedStopReason (p: SeedProgress, l: SeedLimits): string | null {
  if (p.got >= p.want) return `got the ${p.want} seeds I wanted`
  if (p.elapsedMs >= l.maxMs) return `time is up (${Math.round(l.maxMs / 60_000)} min)`
  if (!p.grassLeft) return 'no more grass I may break in range'
  if (p.broken >= l.maxBroken) return `broke ${p.broken} grass, my limit for ${p.want} seeds`
  if (p.failsInRow >= l.maxFailsInRow) return `couldn't reach ${p.failsInRow} grass blocks in a row`
  return null
}

// ------------------------------------------------------------------ known food places

/** Where a known food place came from: the profile, its own farms, a found:* place, a food:* place or spot. */
export type FoodPlaceSource = 'config' | 'farm' | 'crops' | 'village' | 'animals'

export interface FoodPlace {
  name: string
  x: number
  y?: number
  z: number
  dim?: string
  source: FoodPlaceSource
  /** Crops grown there, when known (wheat, carrots, potatoes). */
  crops?: string[]
}

/** How much a source is trusted: the effective distance is the real one divided by this. */
export const PLACE_WEIGHT: Record<FoodPlaceSource, number> = { config: 1.5, farm: 1.5, crops: 1.2, village: 1, animals: 0.6 }
/** Pause after a trip: empty or unreachable, and after a good harvest (crops take a while to grow back). */
export const TRIP_PAUSE_MS = { empty: 45 * 60_000, ok: 20 * 60_000 }

export interface FoodPlaceRules {
  /** Places this close are what the harvest/hunt steps see already (default 48). */
  minDistance?: number
  /** Further than this is no trip (default 4000). */
  maxDistance?: number
  dim?: string
  /** Per-place pause (name -> until, epoch ms). */
  paused?: Record<string, number>
  now?: number
  /** True when a place lies in a remembered danger zone. */
  inDanger? (p: XZ): boolean
}

/**
 * Known food places worth a trip, best first: same dimension, not paused, not in a danger zone,
 * between minDistance and maxDistance away. Places within 48 blocks of each other are one (the
 * more trusted one stays). Order: distance divided by the source's weight, so a configured
 * village or its own farm wins over a found field of about the same distance.
 */
export function rankFoodPlaces (places: readonly FoodPlace[], from: XZ, r: FoodPlaceRules = {}): (FoodPlace & { distance: number })[] {
  const now = r.now ?? Date.now()
  const min = r.minDistance ?? 48
  const max = r.maxDistance ?? 4000
  const ok = places
    .filter(p => !r.dim || !p.dim || p.dim === r.dim)
    .filter(p => !((r.paused?.[p.name] ?? 0) > now))
    .filter(p => !r.inDanger?.(p))
    .map(p => ({ ...p, distance: Math.hypot(p.x - from.x, p.z - from.z) }))
    .filter(p => p.distance >= min && p.distance <= max)
    .sort((a, b) => a.distance / PLACE_WEIGHT[a.source] - b.distance / PLACE_WEIGHT[b.source])
  const out: (FoodPlace & { distance: number })[] = []
  for (const p of ok) {
    const twin = out.find(q => Math.hypot(q.x - p.x, q.z - p.z) <= 48)
    if (!twin) out.push(p)
    else if (!twin.crops && p.crops) twin.crops = p.crops
  }
  return out
}

/** Which named places are food places: found:<crop>, found:village, food:village_farm, food:animals. */
export function placeSource (name: string): FoodPlaceSource | null {
  if (/^found:(wheat|carrots?|potato(es)?|beetroots?|wheat_seeds|beetroot_seeds)$/.test(name)) return 'crops'
  if (name === 'found:village' || name === 'food:village_farm') return name === 'food:village_farm' ? 'crops' : 'village'
  if (name === 'food:animals' || name === 'found:animals') return 'animals'
  if (/^farm:/.test(name)) return 'farm'
  return null
}
