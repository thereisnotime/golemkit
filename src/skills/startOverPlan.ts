// Starting over somewhere else (pure, unit tested in test/start-over-plan.test.ts). The owner of a
// bot stuck in a bad spot (no grass for seeds, no trees close, animals far away) says "start
// over": the bot packs the most precious things from its chests near home, walks off in one
// direction by day, digs in at night, and settles at the first place far enough away that passes
// the site rules (grass, trees, water, animals; not a bad biome, protected or built on, all knobs
// in settings.startOver). Then home, bed and a chest go there, and its usual behaviours build
// fresh around the new home.
//
// Here: the settings (settings.startOver, per-key fallback), the pack ranking (packPlan), the
// heading (chooseHeading, headingAfterBlock), the site verdict (siteVerdict) and the state machine
// (startOverStep). skills/startOver.ts reads the world into these and does the walking.

import { toggleSettings } from '../core/toggles.ts'

export interface XZ { x: number, z: number }
export interface Pos { x: number, y: number, z: number }

// ------------------------------------------------------------------ settings

export interface AvoidPoint extends XZ { name?: string, radius: number }

/**
 * settings.startOver. The type, range and description of every key live in the startOver.*
 * toggles (core/toggles.ts); startOverSettings reads them with per-key fallback.
 */
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
  /** Minutes per leg before it counts as blocked. */
  legMinutes: number
  /** A failed leg that moved fewer blocks than this counts as blocked. */
  blockedMoved: number
  /** Detour angles tried either side of the heading, in order. */
  detours: number[]
  /** A compass direction to head in (n, ne, e, ...), or '' to pick one away from spawn and the avoid points. */
  direction: string
  /** Dimensions a start-over may run in. */
  dimensions: string[]
  /** World spawn is kept this far away (spawnOf), blocks. */
  spawnRadius: number
  /** More places to keep away from (a village, someone's base). */
  avoid: AvoidPoint[]
  /** Radius of an avoid point that gives none. */
  avoidRadius: number
  /** Item names (a trailing * matches a prefix, a leading * a suffix) packed first, whatever the table says. */
  take: string[]
  /** Item names never packed. */
  leave: string[]
  /** Inventory slots left free after packing (for pickups on the way). */
  freeSlots: number
  /** Chests within this many blocks of home are packed from. */
  packRadius: number
  /** With more used slots than this, what isn't worth packing goes into the old chests first. */
  roomAbove: number
  /** Pack value kinds (PackKind) put into the new chest on settling. */
  stash: string[]
  /** Site rules. */
  minGrass: number
  minLogs: number
  minWater: number
  minAnimals: number
  /** Blocks of somebody's build within the look radius that rule a site out. */
  maxBuildBlocks: number
  /** Biome names (prefix*, *suffix) a site must not be in. */
  badBiomes: string[]
  /** Where water freezes counts as a bad biome too. */
  badCold: boolean
  /** Surface ice counts as water. */
  iceAsWater: boolean
  /** Look radii: grass, logs and builds; water; animals. */
  lookRadius: number
  waterRadius: number
  animalRadius: number
  /** Logs deeper than this under the surface aren't trees. */
  treeDepth: number
  /** Site score weights. */
  weights: { grass: number, logs: number, water: number, animals: number, badBiome: number, build: number }
  /** Counts above these don't add to the score. */
  caps: { grass: number, logs: number, water: number, animals: number }
  /** What the fallback place (once the range is used up) needs. */
  fallback: { grass: number, logs: number }
  /** Rejected looks in a row after which it turns (0: never). */
  turnAfterRejects: number
  /** Turns before it makes do. */
  maxTurns: number
  /** Stops walking this long before dark. */
  duskSeconds: number
  /** Packs and leaves only with this much daylight left. */
  leaveDaylightSeconds: number
  /** Failed bunkers in a night before it waits for the morning. */
  shelterTries: number
  /** Blocks walked on after a failed bunker, and after one refused on protected ground. */
  shelterStep: number
  protectedStep: number
  /** Longest a night bunker is kept, minutes. */
  shelterMinutes: number
  /** Failed walks to a far settle target before settling where it stands, and what counts as far. */
  settleTries: number
  settleNear: number
  /** Things within this many blocks of the old base belong to it. */
  oldBaseRadius: number
  /** More place names and storage keys dropped on leaving (modules register their own). */
  dropPlaces: string[]
  dropKeys: string[]
}

export const START_OVER_DEFAULTS: StartOverSettings = {
  go: false,
  run: '',
  minDistance: 500,
  maxDistance: 1500,
  legLength: 96,
  legMinutes: 4,
  blockedMoved: 16,
  detours: [45, 90],
  direction: '',
  dimensions: ['overworld'],
  spawnRadius: 300,
  avoid: [],
  avoidRadius: 400,
  take: [],
  leave: [],
  freeSlots: 2,
  packRadius: 48,
  roomAbove: 24,
  stash: ['treasure', 'metal', 'ore'],
  minGrass: 24,
  minLogs: 8,
  minWater: 1,
  minAnimals: 2,
  maxBuildBlocks: 6,
  badBiomes: ['snowy_*', 'frozen_*', 'ice_spikes', 'grove', 'jagged_peaks'],
  badCold: true,
  iceAsWater: false,
  lookRadius: 32,
  waterRadius: 64,
  animalRadius: 64,
  treeDepth: 12,
  weights: { grass: 0.25, logs: 1, water: 3, animals: 4, badBiome: 100, build: 10 },
  caps: { grass: 200, logs: 60, water: 10, animals: 10 },
  fallback: { grass: 8, logs: 4 },
  turnAfterRejects: 3,
  maxTurns: 2,
  duskSeconds: 30,
  leaveDaylightSeconds: 120,
  shelterTries: 3,
  shelterStep: 12,
  protectedStep: 24,
  shelterMinutes: 15,
  settleTries: 5,
  settleNear: 64,
  oldBaseRadius: 256,
  dropPlaces: [],
  dropKeys: []
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export const COMPASS = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'] as const

/** settings.startOver with per-key fallback from the startOver.* toggle schemas: a bad value falls back on its default, the rest still apply. */
export function startOverSettings (raw: unknown): StartOverSettings {
  const s = toggleSettings('startOver', raw, START_OVER_DEFAULTS)
  // across keys: the range is always beyond the distance to settle at, avoid points get a radius
  s.maxDistance = Math.max(s.minDistance + 64, s.maxDistance)
  s.avoid = s.avoid.map(a => ({ ...a, radius: a.radius ?? s.avoidRadius }))
  return s
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

/** The 8 compass headings in degrees. */
export const HEADINGS = COMPASS.map((_, i) => i * 45)

/** A heading in whole degrees, 0..359. */
export function normHeading (deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360
}

/**
 * Which way to go from `from`: the given direction, else the one of `options` (the 8 compass
 * directions) whose path (to `range`) stays furthest from the avoid points (spawn, a village),
 * ties broken by pointing away from the first avoid point. Pure.
 */
export function chooseHeading (from: XZ, avoid: readonly AvoidPoint[], range: number, direction = '', options: readonly number[] = HEADINGS): number {
  const given = direction ? compassAngle(direction) : null
  if (given !== null) return given
  let best = options[0] ?? 0
  let bestScore = -Infinity
  for (const deg of options) {
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

/** Detour offsets tried in turn, either side of the heading: [45, 90] gives 45, -45, 90, -90. Pure. */
export function detourOffsets (detours: readonly number[] = START_OVER_DEFAULTS.detours): number[] {
  return detours.flatMap(d => [d, -d])
}

/** The heading for the next leg after `fails` blocked legs in a row (0: the main heading). Pure. */
export function headingAfterBlock (main: number, fails: number, detours: readonly number[] = START_OVER_DEFAULTS.detours): number {
  if (fails <= 0) return main
  const offs = detourOffsets(detours)
  return main + offs[(fails - 1) % offs.length]!
}

/**
 * The heading for the next leg: from headingAfterBlock(main, fails) on, the first of it and its
 * 45/90 degree detours whose leg doesn't end (or pass half way) over water, by `wet` (true: water,
 * false: land, null: not loaded, counts as land). Null when all of them are wet (an ocean ahead). Pure.
 */
export function dryLegHeading (main: number, fails: number, wet: (deg: number) => boolean | null, detours: readonly number[] = START_OVER_DEFAULTS.detours): number | null {
  const first = headingAfterBlock(main, fails, detours)
  const tries = [first, ...detourOffsets(detours).map(d => first + d)]
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
  /** Water freezes here (a cold biome or a mountain top). */
  cold: boolean
  /** Grass blocks open to the sky (and grass plants: seeds) nearby. */
  grass: number
  /** Logs of natural trees nearby. */
  logs: number
  /** Water sources open to the sky that don't freeze (and surface ice with iceAsWater). */
  water: number
  /** Passive animals in sight. */
  animals: number
  /** Blocks that look like somebody's build nearby. */
  buildBlocks: number
  /** In a protected area (spawn protection, a claim). */
  protected: boolean
}

export interface SiteVerdict { ok: boolean, score: number, why: string }

type SiteRules = Pick<StartOverSettings, 'minGrass' | 'minLogs' | 'minWater' | 'minAnimals' | 'maxBuildBlocks' | 'badBiomes' | 'badCold' | 'weights' | 'caps'>

/** The biome is one the settings rule out: a name on badBiomes (prefix*, *suffix), or cold with badCold. Pure. */
export function badBiome (f: Pick<SiteFacts, 'biome' | 'cold'>, s: Pick<StartOverSettings, 'badBiomes' | 'badCold'>): boolean {
  if (s.badCold && f.cold) return true
  const b = f.biome?.replace(/^minecraft:/, '')
  return !!b && s.badBiomes.some(p => nameMatches(p, b))
}

/** Whether a place is good enough to start over at, with a score for "the best seen so far". Pure. */
export function siteVerdict (f: SiteFacts, s: SiteRules): SiteVerdict {
  const have = `grass ${f.grass}, logs ${f.logs}, water ${f.water}, animals ${f.animals}${f.biome ? `, ${f.biome.replace(/_/g, ' ')}` : ''}`
  const bad = badBiome(f, s)
  const w = s.weights
  const c = s.caps
  // a usable score even for places that fail; protected ground never wins
  const score = Math.min(f.grass, c.grass) * w.grass + Math.min(f.logs, c.logs) * w.logs + Math.min(f.water, c.water) * w.water + Math.min(f.animals, c.animals) * w.animals -
    (bad ? w.badBiome : 0) - (f.protected ? PROTECTED_PENALTY : 0) - Math.max(0, f.buildBlocks - s.maxBuildBlocks) * w.build
  const no: string[] = []
  if (f.protected) no.push('protected area')
  if (bad) no.push(f.cold && s.badCold ? 'cold (water freezes)' : 'bad biome')
  if (f.buildBlocks > s.maxBuildBlocks) no.push(`somebody's build (${f.buildBlocks} blocks)`)
  if (f.grass < s.minGrass) no.push(`little grass (${f.grass})`)
  if (f.logs < s.minLogs) no.push(`few trees (${f.logs} logs)`)
  if (f.water < s.minWater) no.push('no water')
  if (f.animals < s.minAnimals) no.push(`few animals (${f.animals})`)
  return no.length ? { ok: false, score, why: `${no.join(', ')}; ${have}` } : { ok: true, score, why: have }
}

/** Taken off the score of a protected place: it never wins over one that isn't. */
const PROTECTED_PENALTY = 1000

/** Good enough as a fallback once the range is used up: not protected, built on or in a bad biome, fallback.grass and fallback.logs. Pure. */
export function fallbackOk (f: SiteFacts, s: Pick<StartOverSettings, 'maxBuildBlocks' | 'badBiomes' | 'badCold' | 'fallback'>): boolean {
  return !f.protected && !badBiome(f, s) && f.buildBlocks <= s.maxBuildBlocks && f.grass >= s.fallback.grass && f.logs >= s.fallback.logs
}

// ------------------------------------------------------------------ the state machine

export type StartOverPhase = 'packing' | 'travelling' | 'settling' | 'settled' | 'failed'

export interface StartOverState {
  phase: StartOverPhase
  startedAt: number
  /** Who or what started it (a player's name, "settings"). */
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
  /** Times the main heading turned. */
  turns?: number
  /** Main headings this run has tried (0..359; turnHeading picks among the others). */
  tried?: number[]
  /** Legs walked since the last turn. */
  legsSinceTurn?: number
  /** Blocks actually walked since the last turn (the range after a turn; short mountain legs count for what they moved). */
  walkedSinceTurn?: number
  /** settings.startOver.run that started it. */
  run?: string
  /** Times the walk to the settle target failed. */
  settleFails?: number
  /** Places looked at and rejected in a row (turnAfterRejects). */
  rejects?: number
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
  /** The places to keep away from (spawn, settings.startOver.avoid): turns are scored against them. */
  avoid?: readonly AvoidPoint[]
  /** Whether a leg at a heading ends or passes over water (true), land (false), or isn't loaded (null). */
  wet?: (deg: number) => boolean | null
  /** In the water now: every way looks wet from there, so it doesn't turn at an ocean. */
  swimming?: boolean
  /** The dimension it is in, when known. */
  dim?: string
}

export type StartOverStep =
  | { do: 'pack' }
  | { do: 'leave' }
  | { do: 'shelter' }
  | { do: 'wait', why: string }
  | { do: 'look' }
  | { do: 'leg', heading: number, target: XZ, around?: boolean }
  | { do: 'settle', at: Pos, why: string }
  | { do: 'turn', heading: number, why: string }
  | { do: 'give_up', why: string }
  | { do: 'none' }

/**
 * The next step of a start-over. packing: pack by day, then leave (the behaviour moves it on to
 * travelling); at night or with under leaveDaylightSeconds of daylight it waits for the morning.
 * travelling: by night shelter (after shelterTries failed bunkers it waits for the morning); in
 * the last duskSeconds of daylight wait; by day, far enough from the old base and outside the
 * avoid points, turn after turnAfterRejects rejected looks in a row, else look at the place (with
 * `site` known: settle when it passes); past maxDistance settle at the best fallback seen, else
 * turn (maxTurns times), else settle at the best place seen or give up; otherwise walk the next leg.
 * settling: settle at the target. Pure.
 */
export function startOverStep (st: StartOverState | null | undefined, f: StepFacts, s: StartOverSettings): StartOverStep {
  if (!st) return { do: 'none' }
  if (st.phase === 'settled' || st.phase === 'failed') return { do: 'none' }
  // packing happens at home and leaving right after, so it waits for the morning (home is safe at night)
  if (st.phase === 'packing') return canLeave(f.isNight ? 0 : f.daylightMs, s) ? { do: 'pack' } : { do: 'wait', why: 'leaving at daybreak' }
  if (st.phase === 'settling') return st.target ? { do: 'settle', at: st.target, why: st.target.why } : { do: 'look' }
  // travelling: only in the old base's dimension (a portal, or a respawn somewhere odd)
  if (f.dim && st.origin.dim && dimName(f.dim) !== dimName(st.origin.dim)) return { do: 'wait', why: `in the ${dimName(f.dim)}, the run is in the ${dimName(st.origin.dim)}` }
  // no shelter after shelterTries: wait for the morning where it is (walking at night is how bots die)
  if (f.isNight) return (st.shelterFails ?? 0) >= s.shelterTries ? { do: 'wait', why: 'no shelter tonight, waiting for the morning' } : { do: 'shelter' }
  if (f.daylightMs < s.duskSeconds * 1000) return { do: 'wait', why: 'dusk: digging in once it is dark' }
  const dist = Math.hypot(f.pos.x - st.origin.x, f.pos.z - st.origin.z)
  if (dist >= s.minDistance && !f.avoided) {
    if (s.turnAfterRejects > 0 && (st.rejects ?? 0) >= s.turnAfterRejects && (st.turns ?? 0) < s.maxTurns) {
      const h = turnHeading(st, f.pos, f.avoid ?? [], s)
      if (h !== null) return { do: 'turn', heading: h, why: `${st.rejects} places in a row no good that way` }
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
    const h = (st.turns ?? 0) < s.maxTurns ? turnHeading(st, f.pos, f.avoid ?? [], s) : null
    if (h !== null) return { do: 'turn', heading: h, why: `nothing good within ${s.maxDistance} blocks that way` }
    // out of turns: the best place it looked at beats wherever it happens to stand (a mountain top)
    if (st.best) return { do: 'settle', at: st.best, why: `nothing good after ${(st.turns ?? 0) + 1} directions, the best place seen: ${st.best.why}` }
    return { do: 'give_up', why: `nothing good within ${s.maxDistance} blocks after ${(st.turns ?? 0) + 1} directions` }
  }
  return leg(st, f, s)
}

/**
 * The next leg: the main heading (or its detour after blocked legs), around water by `f.wet` (the
 * first detour that stays on land). Water all round from land (an ocean): turn to the best untried
 * dry heading while turns are left, else swim the main one.
 */
function leg (st: StartOverState, f: StepFacts, s: StartOverSettings): StartOverStep {
  const main = headingAfterBlock(st.heading ?? 0, st.fails ?? 0, s.detours)
  const dry = f.wet ? dryLegHeading(st.heading ?? 0, st.fails ?? 0, f.wet, s.detours) : main
  if (dry === null && !f.swimming && (st.turns ?? 0) < s.maxTurns) {
    const h = turnHeading(st, f.pos, f.avoid ?? [], s, f.wet)
    if (h !== null) return { do: 'turn', heading: h, why: `water all the way ${angleCompass(main)}` }
  }
  const heading = dry ?? main
  return { do: 'leg', heading, target: pointAt(f.pos, heading, s.legLength), ...(heading !== main ? { around: true } : {}) }
}

/** "minecraft:the_nether" -> "the_nether". */
function dimName (d: string): string {
  return d.replace(/^minecraft:/, '')
}

/** Whether a dimension is one a start-over may run in (startOver.dimensions). Pure. */
export function dimensionOk (dim: string | undefined, s: Pick<StartOverSettings, 'dimensions'>): boolean {
  return !dim || s.dimensions.some(d => dimName(d) === dimName(dim))
}

/**
 * The heading for a turn: the best of the compass headings this run hasn't tried (and, with
 * `wet`, that don't end in water), scored like chooseHeading against the avoid points plus the
 * old base (out to minDistance), over the length a new way gets. Null when none is left. Pure.
 */
export function turnHeading (st: Pick<StartOverState, 'tried' | 'heading' | 'origin'>, from: XZ, avoid: readonly AvoidPoint[], s: Pick<StartOverSettings, 'minDistance' | 'maxDistance'>, wet?: (deg: number) => boolean | null): number | null {
  const tried = new Set((st.tried ?? [st.heading ?? 0]).map(normHeading))
  if (st.heading !== undefined) tried.add(normHeading(st.heading))
  const options = HEADINGS.filter(h => !tried.has(h) && (!wet || wet(h) !== true))
  if (!options.length) return null
  const points = [...avoid, { x: st.origin.x, z: st.origin.z, radius: s.minDistance, name: 'old base' }]
  return chooseHeading(from, points, Math.max(64, s.maxDistance - s.minDistance), '', options)
}

// ------------------------------------------------------------------ what a step leaves behind

/** After a look: the best place so far and the rejects in a row. Pure. */
export function applyLook (st: StartOverState, at: Pos, f: SiteFacts, s: StartOverSettings): { state: StartOverState, verdict: SiteVerdict } {
  const v = siteVerdict(f, s)
  return { state: { ...st, best: betterBest(st.best, at, v, fallbackOk(f, s)), rejects: v.ok ? 0 : (st.rejects ?? 0) + 1 }, verdict: v }
}

/** After a leg: counts, the range walked since the last turn, and blocked legs in a row (a failed leg that moved under blockedMoved). Pure. */
export function applyLeg (st: StartOverState, r: { ok: boolean, moved: number, dist: number }, s: Pick<StartOverSettings, 'blockedMoved'>): StartOverState {
  return {
    ...st,
    legs: (st.legs ?? 0) + 1,
    legsSinceTurn: (st.legsSinceTurn ?? 0) + 1,
    walkedSinceTurn: (st.walkedSinceTurn ?? 0) + r.moved,
    fails: !r.ok && r.moved < s.blockedMoved ? (st.fails ?? 0) + 1 : 0,
    farthest: Math.max(st.farthest ?? 0, r.dist)
  }
}

/** After a turn: the new heading, tried, a fresh range, detours and rejects. Pure. */
export function applyTurn (st: StartOverState, heading: number): StartOverState {
  const tried = [...new Set([...(st.tried ?? (st.heading !== undefined ? [normHeading(st.heading)] : [])), normHeading(heading)])]
  return { ...st, heading, tried, turns: (st.turns ?? 0) + 1, legsSinceTurn: 0, walkedSinceTurn: 0, fails: 0, rejects: 0 }
}

/** Leaving the old base: travelling on `heading` with everything counted from zero. Pure. */
export function applyLeave (st: StartOverState, heading: number, packed: Record<string, number>): StartOverState {
  return { ...st, phase: 'travelling', heading, tried: [normHeading(heading)], packed, legs: 0, fails: 0, turns: 0, legsSinceTurn: 0, walkedSinceTurn: 0, farthest: 0, rejects: 0, best: undefined, settleFails: 0 }
}

/** By day the night's failed bunkers are forgotten (the same state when there are none). Pure. */
export function applyDay (st: StartOverState): StartOverState {
  return st.shelterFails ? { ...st, shelterFails: 0 } : st
}

/**
 * A bunker failed (shelterFallback): the state with the try counted (unless protected ground), and
 * how far to walk on along the heading before trying again (0: it has used its shelterTries and
 * waits for the morning). Pure.
 */
export function applyShelterFail (st: StartOverState, message: string, s: Pick<StartOverSettings, 'shelterStep' | 'protectedStep' | 'shelterTries'>): { state: StartOverState, counts: boolean, step: number } {
  const fb = shelterFallback(message, s)
  const state = fb.counts ? { ...st, shelterFails: (st.shelterFails ?? 0) + 1 } : st
  return { state, counts: fb.counts, step: (state.shelterFails ?? 0) < s.shelterTries ? fb.step : 0 }
}

/** The walk to the settle target failed `left` blocks short: retry later (counted), or settle where it stands. Pure. */
export function settleNext (st: StartOverState, left: number, s: Pick<StartOverSettings, 'settleTries' | 'settleNear'>): { do: 'retry', state: StartOverState } | { do: 'here' } {
  return settleRetry(st.settleFails ?? 0, left, s) ? { do: 'retry', state: { ...st, settleFails: (st.settleFails ?? 0) + 1 } } : { do: 'here' }
}

/** The best place so far after looking at one: higher score wins, fallback-worthy ones over others. Pure. */
export function betterBest (best: StartOverState['best'], at: Pos, v: SiteVerdict, fallback: boolean): StartOverState['best'] {
  const cand = { x: at.x, y: at.y, z: at.z, score: v.score, why: v.why, fallback }
  if (!best) return cand
  if (fallback !== best.fallback) return fallback ? cand : best
  return v.score > best.score ? cand : best
}

// ------------------------------------------------------------------ leaving the old base behind

/** Whether `p` is within `radius` (startOver.oldBaseRadius) of the base it left (the place old_base), so pinned chests there don't count. Pure. */
export function atOldBase (places: Record<string, unknown> | undefined, p: XZ, radius = START_OVER_DEFAULTS.oldBaseRadius): boolean {
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
export function abandonedState (get: (key: string) => unknown, origin: Pos & { dim?: string }, radius = START_OVER_DEFAULTS.oldBaseRadius): { set: Record<string, unknown>, del: string[] } {
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
 * respawns) it isn't the ground's fault, so it doesn't count towards shelterTries and it walks
 * protectedStep blocks on to get out; other failures count and it moves shelterStep blocks on to
 * try new ground. Pure.
 */
export function shelterFallback (message: string, s: Pick<StartOverSettings, 'shelterStep' | 'protectedStep'> = START_OVER_DEFAULTS): { counts: boolean, step: number } {
  return /protected area/.test(message) ? { counts: false, step: s.protectedStep } : { counts: true, step: s.shelterStep }
}

/** Enough daylight left (ms) to pack and leave (leaveDaylightSeconds). Pure. */
export function canLeave (daylightMs: number, s: Pick<StartOverSettings, 'leaveDaylightSeconds'>): boolean {
  return daylightMs > 0 && daylightMs >= s.leaveDaylightSeconds * 1000
}

/** Whether settings.startOver.go starts a run now: no run stored yet, or a finished one with another run id. Pure. */
export function goFires (st: Pick<StartOverState, 'phase' | 'run'> | null | undefined, s: Pick<StartOverSettings, 'go' | 'run'>): boolean {
  if (!s.go) return false
  if (!st) return true
  const done = st.phase === 'settled' || st.phase === 'failed'
  return done && s.run !== '' && (st.run ?? '') !== s.run
}

/** Settling at a far target that it couldn't walk to: try again (settleTries times) unless it is within settleNear already. Pure. */
export function settleRetry (fails: number, distance: number, s: Pick<StartOverSettings, 'settleTries' | 'settleNear'> = START_OVER_DEFAULTS): boolean {
  return distance > s.settleNear && fails < s.settleTries
}

/**
 * settings.startOver.run changed while a run is travelling (the owner changed the plan): carry on
 * from where it is with the new direction (or the old heading), fresh turns, range and reject count,
 * same origin. Null when nothing changes. Pure.
 */
export function redirected (st: StartOverState | null | undefined, s: Pick<StartOverSettings, 'go' | 'run' | 'direction'>): StartOverState | null {
  if (!st || !s.go || !s.run || st.phase !== 'travelling' || (st.run ?? '') === s.run) return null
  const given = s.direction ? compassAngle(s.direction) : null
  const heading = given ?? st.heading
  return { ...st, run: s.run, ...(s.direction ? { direction: s.direction } : {}), heading, tried: heading !== undefined ? [normHeading(heading)] : [], turns: 0, legsSinceTurn: 0, walkedSinceTurn: 0, rejects: 0, fails: 0 }
}

/** A surface block a leg shouldn't end on: water, lava and ice (frozen oceans and rivers have holes and drowned under them). Pure. */
export function wetTop (name: string): boolean {
  return /water|lava|bubble_column|kelp|seagrass|^ice$|packed_ice|blue_ice|frosted_ice/.test(name)
}
