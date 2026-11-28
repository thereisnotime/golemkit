// Starting over somewhere else (pure, unit tested in test/start-over-plan.test.ts). The owner of a
// bot stuck in a bad spot (Pax: a snowy fortress with no grass, frozen shores and animals 285
// blocks away) says "start over": the bot packs the most precious things from its chests near
// home, walks off in one direction by day, digs in at night, and settles at the first place far
// enough away that has grass, trees, water and animals and isn't snowy, protected or built on.
// Then home, bed and a chest go there, and its usual behaviours build fresh around the new home.
//
// Here: the settings (settings.startOver, per-key fallback), the pack ranking (packPlan), the
// heading (chooseHeading, headingAfterBlock), the site verdict (siteVerdict) and the state machine
// (startOverStep). skills/startOver.ts reads the world into these and does the walking.

export interface XZ { x: number, z: number }
export interface Pos { x: number, y: number, z: number }

// ------------------------------------------------------------------ settings

export interface AvoidPoint extends XZ { name?: string, radius: number }

export interface StartOverSettings {
  /** Start on its own once (on start), remembered in storage so it doesn't fire again after it is done. */
  go: boolean
  /** With go: a run id; a new id starts a new start-over once even after an earlier one finished. */
  run: string
  /** Settle no closer than this to the old base, blocks. */
  minDistance: number
  /** Look no further than this from the old base, blocks. */
  maxDistance: number
  /** Walk this far per leg before looking around again, blocks. */
  legLength: number
  /** A compass direction to head in (n, ne, e, ...), or '' to pick one away from spawn and the avoid points. */
  direction: string
  /** World spawn is kept this far away (spawnOf), blocks. */
  spawnRadius: number
  /** More places to keep away from (a village, someone's base). */
  avoid: AvoidPoint[]
  /** Item names (a trailing * matches a prefix, a leading * a suffix) packed first, whatever the table says. */
  take: string[]
  /** Item names never packed. */
  leave: string[]
  /** Inventory slots left free after packing (for pickups on the way). */
  freeSlots: number
  /** Site rules. */
  minGrass: number
  minLogs: number
  minWater: number
  minAnimals: number
  /** Blocks of somebody's build within the look radius that rule a site out. */
  maxBuildBlocks: number
  /** Allow snowy and frozen biomes (default off: the whole point). */
  allowSnow: boolean
  /** Minutes per leg before it counts as blocked. */
  legMinutes: number
  /** Times the heading turns 90 degrees after reaching maxDistance without a site, before giving up. */
  maxTurns: number
  /** Snowy places looked at in a row after which the heading turns 90 degrees (0: never). */
  snowTurnAfter: number
}

export const START_OVER_DEFAULTS: StartOverSettings = {
  go: false,
  run: '',
  minDistance: 500,
  maxDistance: 1500,
  legLength: 96,
  direction: '',
  spawnRadius: 300,
  avoid: [],
  take: [],
  leave: [],
  freeSlots: 2,
  minGrass: 24,
  minLogs: 8,
  minWater: 1,
  minAnimals: 2,
  maxBuildBlocks: 6,
  allowSnow: false,
  legMinutes: 4,
  maxTurns: 2,
  snowTurnAfter: 3
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, lo: number, hi: number): number => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.round(num(v, d, lo, hi))
const bool = (v: unknown, d: boolean): boolean => typeof v === 'boolean' ? v : d
const strs = (v: unknown, d: string[]): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : d

export const COMPASS = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'] as const

function parseAvoid (v: unknown): AvoidPoint[] {
  if (!Array.isArray(v)) return []
  const out: AvoidPoint[] = []
  for (const a of v) {
    const o = obj(a)
    if (typeof o.x !== 'number' || typeof o.z !== 'number') continue
    out.push({ x: o.x, z: o.z, radius: num(o.radius, 400, 0, 10_000), ...(typeof o.name === 'string' ? { name: o.name } : {}) })
  }
  return out
}

/** settings.startOver with per-key fallback: a bad value falls back on its default, the rest still apply. */
export function startOverSettings (raw: unknown): StartOverSettings {
  const o = obj(raw)
  const d = START_OVER_DEFAULTS
  const min = int(o.minDistance, d.minDistance, 64, 5000)
  const dir = typeof o.direction === 'string' && (COMPASS as readonly string[]).includes(o.direction.toLowerCase()) ? o.direction.toLowerCase() : d.direction
  return {
    go: bool(o.go, d.go),
    run: typeof o.run === 'string' || typeof o.run === 'number' ? String(o.run) : d.run,
    minDistance: min,
    maxDistance: Math.max(min + 64, int(o.maxDistance, d.maxDistance, 128, 10_000)),
    legLength: int(o.legLength, d.legLength, 32, 256),
    direction: dir,
    spawnRadius: int(o.spawnRadius, d.spawnRadius, 0, 5000),
    avoid: Array.isArray(o.avoid) ? parseAvoid(o.avoid) : d.avoid,
    take: strs(o.take, d.take),
    leave: strs(o.leave, d.leave),
    freeSlots: int(o.freeSlots, d.freeSlots, 0, 20),
    minGrass: int(o.minGrass, d.minGrass, 0, 1000),
    minLogs: int(o.minLogs, d.minLogs, 0, 1000),
    minWater: int(o.minWater, d.minWater, 0, 100),
    minAnimals: int(o.minAnimals, d.minAnimals, 0, 100),
    maxBuildBlocks: int(o.maxBuildBlocks, d.maxBuildBlocks, 0, 1000),
    allowSnow: bool(o.allowSnow, d.allowSnow),
    legMinutes: num(o.legMinutes, d.legMinutes, 0.5, 30),
    maxTurns: int(o.maxTurns, d.maxTurns, 0, 3),
    snowTurnAfter: int(o.snowTurnAfter, d.snowTurnAfter, 0, 20)
  }
}

// ------------------------------------------------------------------ packing

const GEAR_SLOTS: [RegExp, string][] = [
  [/_sword$/, 'sword'], [/_pickaxe$/, 'pickaxe'], [/_axe$/, 'axe'], [/_shovel$/, 'shovel'], [/_hoe$/, 'hoe'],
  [/_helmet$/, 'helmet'], [/_chestplate$/, 'chestplate'], [/_leggings$/, 'leggings'], [/_boots$/, 'boots'],
  [/^shield$/, 'shield'], [/^bow$/, 'bow'], [/^crossbow$/, 'crossbow'], [/^fishing_rod$/, 'fishing_rod'],
  [/^shears$/, 'shears'], [/^flint_and_steel$/, 'flint_and_steel'], [/_bed$/, 'bed'], [/^(water_)?bucket$/, 'bucket']
]
const TIER_RANK: Record<string, number> = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, stone: 2, leather: 1, wooden: 1 }

/** The gear slot an item fills (one of each is packed), or null. */
export function gearSlot (name: string): string | null {
  for (const [re, slot] of GEAR_SLOTS) if (re.test(name)) return slot
  return null
}

/** How good a piece of gear is within its slot (netherite 6 .. wooden/leather 1, plain items 3). */
export function gearRank (name: string): number {
  const m = /^([a-z]+)_/.exec(name)
  return (m && TIER_RANK[m[1]!]) ?? 3
}

/** Value and how many are worth carrying, for anything that isn't gear. */
const STOCK: [RegExp, number, number][] = [
  [/^(netherite_ingot|netherite_scrap|diamond|totem_of_undying|enchanted_golden_apple)$/, 98, 64],
  [/^(emerald|golden_apple|ender_pearl)$/, 88, 64],
  [/^(iron_ingot|raw_iron|iron_ore|deepslate_iron_ore|iron_block|raw_iron_block)$/, 80, 128],
  [/^(diamond_ore|deepslate_diamond_ore|emerald_ore|deepslate_emerald_ore)$/, 80, 16],
  [/^(gold_ingot|raw_gold|gold_ore|deepslate_gold_ore|gold_block)$/, 66, 64],
  [/^arrow$|^spectral_arrow$/, 64, 64],
  [/^(wheat_seeds|beetroot_seeds|carrot|potato|melon_seeds|pumpkin_seeds)$/, 62, 64],
  [/^torch$/, 60, 64],
  [/^(coal|charcoal)$/, 58, 64],
  [/^(redstone|lapis_lazuli|redstone_block|lapis_block|redstone_ore|deepslate_redstone_ore|lapis_ore|deepslate_lapis_ore)$/, 50, 64],
  [/^(copper_ingot|raw_copper|copper_ore|deepslate_copper_ore)$/, 40, 64],
  [/^(string|leather|white_wool|[a-z_]+_wool|feather|bone_meal|flint)$/, 34, 32],
  [/_sapling$/, 32, 16],
  [/(_log|_wood|_stem)$/, 46, 64],
  [/^(cobblestone|cobbled_deepslate)$/, 36, 64],
  [/^(crafting_table|furnace|chest)$/, 30, 1]
]

export interface PackItem { name: string, count: number }

export interface PackInput {
  /** What its chests near home hold, summed. */
  chests: Record<string, number>
  /** What it carries now. */
  inventory: Record<string, number>
  /** Empty inventory slots now. */
  freeSlots: number
  stackSize: (name: string) => number
  /** Food points per item (0: not food, or food that hurts). */
  foodPoints: (name: string) => number
  take?: readonly string[]
  leave?: readonly string[]
  /** Slots to leave free. */
  keepFree?: number
}

export interface PackPick { name: string, count: number, value: number, why: string }

/** `pattern` matches `name`: exact, prefix* or *suffix. */
export function nameMatches (pattern: string, name: string): boolean {
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1))
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

/** Value (0..100) of one more stack of `name` and the most worth carrying, or null when it stays. Pure. */
export function packValue (name: string, foodPoints: (name: string) => number, take: readonly string[] = [], leave: readonly string[] = []): { value: number, cap: number, why: string } | null {
  if (leave.some(p => nameMatches(p, name))) return null
  if (take.some(p => nameMatches(p, name))) return { value: 100, cap: Infinity, why: 'on the take list' }
  const slot = gearSlot(name)
  if (slot) {
    const r = gearRank(name)
    if (slot === 'bed') return { value: 90, cap: 1, why: 'bed' }
    if (slot === 'shield' || slot === 'bow' || slot === 'crossbow') return { value: 85, cap: 1, why: slot }
    return { value: 50 + r * 8, cap: 1, why: `${slot} (gear)` }
  }
  for (const [re, value, cap] of STOCK) if (re.test(name)) return { value, cap, why: 'stock' }
  const fp = foodPoints(name)
  if (fp > 0) return { value: 60 + Math.min(fp, 8), cap: 64, why: 'food' }
  return null
}

/**
 * What to take out of its chests before leaving, most precious first, until the free slots run
 * out: one of each gear slot and only when better than what it carries (iron and diamond gear,
 * the best weapon, armour, shield, bow), ores and ingots, arrows, food, seeds, a bed, torches, a
 * stack of logs and some cobblestone. `take` items come first, `leave` items never. Pure.
 */
export function packPlan (p: PackInput): PackPick[] {
  const take = p.take ?? []
  const leave = p.leave ?? []
  let free = Math.max(0, p.freeSlots - (p.keepFree ?? 0))
  const held = { ...p.inventory }
  // the best piece it carries per gear slot
  const bestHeld: Record<string, number> = {}
  for (const [n, c] of Object.entries(held)) {
    const s = gearSlot(n)
    if (s && c > 0) bestHeld[s] = Math.max(bestHeld[s] ?? 0, gearRank(n))
  }
  const cands: { name: string, value: number, cap: number, why: string }[] = []
  for (const [name, n] of Object.entries(p.chests)) {
    if (n <= 0) continue
    const v = packValue(name, p.foodPoints, take, leave)
    if (v) cands.push({ name, ...v })
  }
  cands.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
  const out: PackPick[] = []
  let foodTaken = Object.entries(held).reduce((s, [n, c]) => s + (p.foodPoints(n) > 0 ? c : 0), 0)
  for (const c of cands) {
    const slot = gearSlot(c.name)
    let want: number
    if (slot && c.why !== 'on the take list') {
      if ((bestHeld[slot] ?? 0) >= gearRank(c.name) && slot !== 'bucket') continue // already carries one as good
      if (slot === 'bucket' && (held.bucket ?? 0) + (held.water_bucket ?? 0) > 0) continue
      want = 1
      bestHeld[slot] = gearRank(c.name)
    } else {
      const cap = c.why === 'food' ? Math.max(0, 64 - foodTaken) : c.cap
      want = Math.min(p.chests[c.name]!, Math.max(0, (Number.isFinite(cap) ? cap : Infinity) - (c.why === 'food' ? 0 : held[c.name] ?? 0)))
    }
    if (want <= 0) continue
    const stack = Math.max(1, p.stackSize(c.name))
    const have = held[c.name] ?? 0
    // slots this needs beyond the partial stack it already carries
    const room = (Math.ceil(have / stack) * stack - have) + free * stack
    want = Math.min(want, room)
    if (want <= 0) continue
    const used = Math.ceil((have + want) / stack) - Math.ceil(have / stack)
    free -= used
    held[c.name] = have + want
    if (c.why === 'food') foodTaken += want
    out.push({ name: c.name, count: want, value: c.value, why: c.why })
  }
  return out
}

// ------------------------------------------------------------------ heading

const DEG = Math.PI / 180

/** Compass word to an angle in degrees (east 0, south 90: Minecraft's +z is south). */
export function compassAngle (dir: string): number | null {
  const i = (COMPASS as readonly string[]).indexOf(dir.toLowerCase())
  return i < 0 ? null : i * 45
}

/** The compass word nearest an angle in degrees. */
export function angleCompass (deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return COMPASS[i]!
}

/** A point `distance` blocks from `from` at `deg`. */
export function pointAt (from: XZ, deg: number, distance: number): XZ {
  return { x: Math.round(from.x + Math.cos(deg * DEG) * distance), z: Math.round(from.z + Math.sin(deg * DEG) * distance) }
}

/**
 * Which way to go from the old base: the given direction, else the one of 8 compass directions
 * whose path (to `range`) stays furthest from the avoid points (spawn, a village), ties broken by
 * pointing away from the first avoid point. Pure.
 */
export function chooseHeading (from: XZ, avoid: readonly AvoidPoint[], range: number, direction = ''): number {
  const given = direction ? compassAngle(direction) : null
  if (given !== null) return given
  let best = 0
  let bestScore = -Infinity
  for (let i = 0; i < 8; i++) {
    const deg = i * 45
    // closest approach to each avoid point along the path, relative to its radius
    let score = Infinity
    for (const a of avoid) {
      let closest = Infinity
      for (let d = 0; d <= range; d += 32) {
        const p = pointAt(from, deg, d)
        closest = Math.min(closest, Math.hypot(p.x - a.x, p.z - a.z))
      }
      score = Math.min(score, closest - a.radius)
    }
    if (!avoid.length) score = 0
    // tie-break: away from the first avoid point
    const a0 = avoid[0]
    const away = a0 ? Math.cos(deg * DEG - Math.atan2(from.z - a0.z, from.x - a0.x)) : 0
    const total = Math.min(score, range) + away
    if (total > bestScore) { bestScore = total; best = deg }
  }
  return best
}

/** Detours tried in turn when a leg is blocked: 45 and 90 degrees either side of the main heading. */
export const DETOURS = [45, -45, 90, -90]

/** The heading for the next leg after `fails` blocked legs in a row (0: the main heading). Pure. */
export function headingAfterBlock (main: number, fails: number): number {
  if (fails <= 0) return main
  return main + DETOURS[(fails - 1) % DETOURS.length]!
}

/**
 * The heading for the next leg: from headingAfterBlock(main, fails) on, the first of it and its
 * 45/90 degree detours whose leg doesn't end (or pass half way) over water, by `wet` (true: water,
 * false: land, null: not loaded, counts as land). Null when all of them are wet (an ocean ahead). Pure.
 */
export function dryLegHeading (main: number, fails: number, wet: (deg: number) => boolean | null): number | null {
  const first = headingAfterBlock(main, fails)
  const tries = [first, ...DETOURS.map(d => first + d)]
  return tries.find(h => wet(h) !== true) ?? null
}

/** Inside an avoid point's radius (spawn, a village). */
export function inAvoided (p: XZ, avoid: readonly AvoidPoint[]): AvoidPoint | null {
  return avoid.find(a => Math.hypot(p.x - a.x, p.z - a.z) < a.radius) ?? null
}

// ------------------------------------------------------------------ the site

export interface SiteFacts {
  /** Biome name at the surface. */
  biome: string | null
  /** Snowy or frozen biome (or water freezes here). */
  snowy: boolean
  /** Grass blocks open to the sky (and grass plants: seeds) nearby. */
  grass: number
  /** Logs of natural trees nearby. */
  logs: number
  /** Water sources open to the sky that don't freeze. */
  water: number
  /** Passive animals in sight. */
  animals: number
  /** Blocks that look like somebody's build nearby. */
  buildBlocks: number
  /** In a protected area (spawn protection, a claim). */
  protected: boolean
}

export interface SiteVerdict { ok: boolean, score: number, why: string }

/** Whether a place is good enough to start over at, with a score for "the best seen so far". Pure. */
export function siteVerdict (f: SiteFacts, s: Pick<StartOverSettings, 'minGrass' | 'minLogs' | 'minWater' | 'minAnimals' | 'maxBuildBlocks' | 'allowSnow'>): SiteVerdict {
  const have = `grass ${f.grass}, logs ${f.logs}, water ${f.water}, animals ${f.animals}${f.biome ? `, ${f.biome.replace(/_/g, ' ')}` : ''}`
  // a usable score even for places that fail: grass and trees matter most, animals are a bonus
  const score = Math.min(f.grass, 200) / 4 + Math.min(f.logs, 60) + Math.min(f.water, 10) * 3 + Math.min(f.animals, 10) * 4 -
    (f.snowy ? 100 : 0) - (f.protected ? 1000 : 0) - Math.max(0, f.buildBlocks - s.maxBuildBlocks) * 10
  const no: string[] = []
  if (f.protected) no.push('protected area')
  if (f.snowy && !s.allowSnow) no.push('snowy')
  if (f.buildBlocks > s.maxBuildBlocks) no.push(`somebody's build (${f.buildBlocks} blocks)`)
  if (f.grass < s.minGrass) no.push(`little grass (${f.grass})`)
  if (f.logs < s.minLogs) no.push(`few trees (${f.logs} logs)`)
  if (f.water < s.minWater) no.push('no water')
  if (f.animals < s.minAnimals) no.push(`few animals (${f.animals})`)
  return no.length ? { ok: false, score, why: `${no.join(', ')}; ${have}` } : { ok: true, score, why: have }
}

/** Good enough as a fallback once the range is used up: not protected, built on or snowy, some grass and trees. */
export function fallbackOk (f: SiteFacts, s: Pick<StartOverSettings, 'maxBuildBlocks' | 'allowSnow'>): boolean {
  return !f.protected && (s.allowSnow || !f.snowy) && f.buildBlocks <= s.maxBuildBlocks && f.grass >= 8 && f.logs >= 4
}

// ------------------------------------------------------------------ the state machine

export type StartOverPhase = 'packing' | 'travelling' | 'settling' | 'settled' | 'failed'

export interface StartOverState {
  phase: StartOverPhase
  startedAt: number
  /** Who or what started it ("pe4ka", "settings"). */
  by: string
  /** The old base (home when it started). */
  origin: Pos & { dim?: string }
  /** The direction asked for (n, ne, ...), over settings.startOver.direction. */
  direction?: string
  /** The main heading in degrees (east 0, south 90). */
  heading?: number
  /** Blocked legs in a row. */
  fails?: number
  /** Legs walked. */
  legs?: number
  /** Times the main heading turned 90 degrees after the range ran out. */
  turns?: number
  /** Legs walked since the last turn. */
  legsSinceTurn?: number
  /** Blocks actually walked since the last turn (the range after a turn; short mountain legs count for what they moved). */
  walkedSinceTurn?: number
  /** settings.startOver.run that started it. */
  run?: string
  /** Times the walk to the settle target failed. */
  settleFails?: number
  /** Snowy places looked at in a row (snowTurnAfter). */
  snowyLooks?: number
  /** Furthest from the origin so far. */
  farthest?: number
  /** The best place looked at so far (a fallback when the range runs out). */
  best?: Pos & { score: number, why: string, fallback: boolean }
  /** Where it settles. */
  target?: Pos & { why: string }
  /** What it packed. */
  packed?: Record<string, number>
  /** Bunkers that failed tonight (reset by day). */
  shelterFails?: number
  /** When it settled, or failed, and why. */
  doneAt?: number
  note?: string
}

export interface StepFacts {
  pos: Pos
  isNight: boolean
  /** Daylight left in ms (0 at night). */
  daylightMs: number
  /** What the place it stands at looks like (only when it looked). */
  site?: SiteFacts | null
  /** In an avoid point's radius. */
  avoided?: boolean
}

export type StartOverStep =
  | { do: 'pack' }
  | { do: 'leave' }
  | { do: 'shelter' }
  | { do: 'wait', why: string }
  | { do: 'look' }
  | { do: 'leg', heading: number, target: XZ }
  | { do: 'settle', at: Pos, why: string }
  | { do: 'turn', heading: number, why: string }
  | { do: 'give_up', why: string }
  | { do: 'none' }

/** Leave the walk this long before dark (ms): it digs in once night falls. */
export const DUSK_MS = 30_000

/**
 * The next step of a start-over. packing: pack by day, then leave (the behaviour moves it on to
 * travelling); at night or late in the day it waits for the morning. travelling: by night shelter (after 3 failed bunkers it waits for the morning); at dusk wait; by
 * day, far enough from the old base and outside the avoid points, look at the place (with `site`
 * known: settle when it passes); past maxDistance settle at the best fallback seen, else turn the
 * main heading 90 degrees (maxTurns times), else give up; otherwise walk the next leg.
 * settling: settle at the target. Pure.
 */
export function startOverStep (st: StartOverState | null | undefined, f: StepFacts, s: StartOverSettings): StartOverStep {
  if (!st) return { do: 'none' }
  if (st.phase === 'settled' || st.phase === 'failed') return { do: 'none' }
  // packing happens at home and leaving right after, so it waits for the morning (home is safe at night)
  if (st.phase === 'packing') return f.isNight || f.daylightMs < DUSK_MS * 4 ? { do: 'wait', why: 'leaving at daybreak' } : { do: 'pack' }
  if (st.phase === 'settling') return st.target ? { do: 'settle', at: st.target, why: st.target.why } : { do: 'look' }
  // travelling
  // no shelter after 3 tries: wait for the morning where it is (walking at night got it killed twice)
  if (f.isNight) return (st.shelterFails ?? 0) >= 3 ? { do: 'wait', why: 'no shelter tonight, waiting for the morning' } : { do: 'shelter' }
  if (f.daylightMs < DUSK_MS) return { do: 'wait', why: 'dusk: digging in once it is dark' }
  const dist = Math.hypot(f.pos.x - st.origin.x, f.pos.z - st.origin.z)
  if (dist >= s.minDistance && !f.avoided) {
    if (s.snowTurnAfter > 0 && (st.snowyLooks ?? 0) >= s.snowTurnAfter && (st.turns ?? 0) < s.maxTurns) {
      return { do: 'turn', heading: (st.heading ?? 0) + 90, why: `snow for ${st.snowyLooks} looks in a row that way` }
    }
    if (f.site === undefined) return { do: 'look' }
    if (f.site) {
      const v = siteVerdict(f.site, s)
      if (v.ok) return { do: 'settle', at: f.pos, why: v.why }
    }
  }
  // the range: distance from the old base, or after a turn the legs walked since (the new way gets the same length)
  const used = (st.turns ?? 0) > 0 ? (st.walkedSinceTurn ?? (st.legsSinceTurn ?? 0) * s.legLength) + s.minDistance : dist
  if (used >= s.maxDistance) {
    if (st.best?.fallback) return { do: 'settle', at: st.best, why: `best place within ${s.maxDistance} blocks: ${st.best.why}` }
    if ((st.turns ?? 0) < s.maxTurns) return { do: 'turn', heading: (st.heading ?? 0) + 90, why: `nothing good within ${s.maxDistance} blocks that way` }
    // out of turns: the best place it looked at beats wherever it happens to stand (a mountain top)
    if (st.best) return { do: 'settle', at: st.best, why: `nothing good after ${(st.turns ?? 0) + 1} directions, the best place seen: ${st.best.why}` }
    return { do: 'give_up', why: `nothing good within ${s.maxDistance} blocks after ${(st.turns ?? 0) + 1} directions` }
  }
  return leg(st, f, s)
}

function leg (st: StartOverState, f: StepFacts, s: StartOverSettings): StartOverStep {
  const heading = headingAfterBlock(st.heading ?? 0, st.fails ?? 0)
  return { do: 'leg', heading, target: pointAt(f.pos, heading, s.legLength) }
}

/** The best place so far after looking at one: higher score wins, fallback-worthy ones over others. Pure. */
export function betterBest (best: StartOverState['best'], at: Pos, v: SiteVerdict, fallback: boolean): StartOverState['best'] {
  const cand = { x: at.x, y: at.y, z: at.z, score: v.score, why: v.why, fallback }
  if (!best) return cand
  if (fallback !== best.fallback) return fallback ? cand : best
  return v.score > best.score ? cand : best
}

// ------------------------------------------------------------------ leaving the old base behind

/** Things within this many blocks of the old base belong to it (places, containers, pinned chests). */
export const OLD_BASE_RADIUS = 256

/** Whether `p` is at the base it left (the place old_base), so pinned chests there don't count. Pure. */
export function atOldBase (places: Record<string, unknown> | undefined, p: XZ, radius = OLD_BASE_RADIUS): boolean {
  return near(places?.old_base, p, radius)
}

/** Storage keys that tie behaviours to the old base and are dropped outright when it leaves. */
export const ABANDON_KEYS = [
  'projects.spots', 'projects.state', 'farms', 'build.active', 'spawnBed', 'spawnBed.searches', 'woodcutting.searches',
  'food.sources.failed', 'food.source', 'lighting.checked'
] as const

/** Place names that mean the old base wherever they are. */
const BASE_PLACE = /^(farm:\d+|farm_plot|furnace|fortress|base|home)$/

/** Within `radius` blocks of the old base (flat distance), for things that carry a position. */
function near (p: unknown, origin: XZ, radius: number): boolean {
  const o = obj(p)
  const pos = obj(o.pos)
  const x = typeof o.x === 'number' ? o.x : typeof pos.x === 'number' ? pos.x : null
  const z = typeof o.z === 'number' ? o.z : typeof pos.z === 'number' ? pos.z : null
  return x !== null && z !== null && Math.hypot(x - origin.x, z - origin.z) <= radius
}

/**
 * What storage looks like after leaving the old base: home gone (it is set again where it
 * settles), the base anchor, project progress, farms and the ring searches dropped (those
 * remember only a radius around home), places, site records, remembered containers, food spots
 * and its beds near the old base dropped, and the old base kept as the place `old_base`. Torches,
 * own blocks, mines, trees and chests it placed stay: they are filtered by distance from home.
 * Returns the keys to set and the keys to delete. Pure.
 */
export function abandonedState (get: (key: string) => unknown, origin: Pos & { dim?: string }, radius = OLD_BASE_RADIUS): { set: Record<string, unknown>, del: string[] } {
  const set: Record<string, unknown> = {}
  const del: string[] = ['home', ...ABANDON_KEYS]
  const places: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(obj(get('places')))) {
    if (BASE_PLACE.test(name) || near(p, origin, radius)) continue
    places[name] = p
  }
  // a second start-over keeps the first old base (the one pinned chests and the owner know)
  if (!places.old_base) places.old_base = { x: origin.x, y: origin.y, z: origin.z, ...(origin.dim ? { dimension: origin.dim } : {}) }
  set.places = places
  const sites: Record<string, unknown> = {}
  for (const [k, r] of Object.entries(obj(get('sites')))) {
    const kind = obj(r).kind
    if (kind === 'home' || kind === 'farm' || near(r, origin, radius) || !obj(r).pos) continue
    sites[k] = r
  }
  set.sites = sites
  const mem: Record<string, Record<string, unknown>> = {}
  for (const [scope, entries] of Object.entries(obj(get('containers.memory')))) {
    const kept: Record<string, unknown> = {}
    for (const [key, e] of Object.entries(obj(entries))) {
      const [x, , z] = key.split(' ').map(Number)
      if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x! - origin.x, z! - origin.z) <= radius) continue
      kept[key] = e
    }
    mem[scope] = kept
  }
  set['containers.memory'] = mem
  const list = (key: string) => { const v = get(key); if (Array.isArray(v)) set[key] = v.filter(p => !near(p, origin, radius)) }
  list('foodSpots')
  list('spawnBed.own')
  list('search.ownChests')
  const ladder = obj(get('foodLadder'))
  if (Object.keys(ladder).length) set.foodLadder = { ...ladder, searches: [] }
  return { set, del }
}

/**
 * What to do when digging in for the night failed: in a protected area (world spawn, where it
 * respawns) it isn't the ground's fault, so it doesn't count towards the 3 tries and it walks 24
 * blocks on to get out; other failures count and it moves 12 blocks on to try new ground. Pure.
 */
export function shelterFallback (message: string): { counts: boolean, step: number } {
  return /protected area/.test(message) ? { counts: false, step: 24 } : { counts: true, step: 12 }
}

/** Whether settings.startOver.go starts a run now: no run stored yet, or a finished one with another run id. Pure. */
export function goFires (st: Pick<StartOverState, 'phase' | 'run'> | null | undefined, s: Pick<StartOverSettings, 'go' | 'run'>): boolean {
  if (!s.go) return false
  if (!st) return true
  const done = st.phase === 'settled' || st.phase === 'failed'
  return done && s.run !== '' && (st.run ?? '') !== s.run
}

/** Settling at a far target that it couldn't walk to: try again (up to 5 times) unless it is close already. Pure. */
export function settleRetry (fails: number, distance: number): boolean {
  return distance > 64 && fails < 5
}

/**
 * settings.startOver.run changed while a run is travelling (the owner changed the plan): carry on
 * from where it is with the new direction (or the old heading), fresh turns, range and snow count,
 * same origin. Null when nothing changes. Pure.
 */
export function redirected (st: StartOverState | null | undefined, s: Pick<StartOverSettings, 'go' | 'run' | 'direction'>): StartOverState | null {
  if (!st || !s.go || !s.run || st.phase !== 'travelling' || (st.run ?? '') === s.run) return null
  const given = s.direction ? compassAngle(s.direction) : null
  return { ...st, run: s.run, ...(s.direction ? { direction: s.direction } : {}), heading: given ?? st.heading, turns: 0, legsSinceTurn: 0, walkedSinceTurn: 0, snowyLooks: 0, fails: 0 }
}

/** A surface block a leg shouldn't end on: water, lava and ice (frozen oceans and rivers have holes and drowned under them). Pure. */
export function wetTop (name: string): boolean {
  return /water|lava|bubble_column|kelp|seagrass|^ice$|packed_ice|blue_ice|frosted_ice/.test(name)
}
