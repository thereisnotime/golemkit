// The staircase mine, planned. Pure and unit tested (test/stair-mine.test.ts); stairMine.ts reads
// the world into these and does the digging.
//
// Pax has stone tools and lives on a frozen lake: no iron ore with an open face within 160
// blocks, and safe mining (rightly) keeps it out of caves without armour. What a player does
// there is dig their own mine: a 1-wide, 2-high staircase down at 45 degrees from a dry spot near
// home to iron depth, lit with torches, then strip branches off a main tunnel, mining the ore
// that shows in the walls, and back up the same stairs. A tunnel it digs itself never opens into
// a cave (minePlan.caveHazard), so it is far safer than the cave trip safe mining refuses, and it
// is remembered (storage `mines`, site kind `mine`) so the next trip walks down and carries on.
import type { MiningGear, MiningSettings, Kit, Readiness, BlockLook, P } from './minePlan.ts'

/** settings.mine (profile `settings: mine:`, live with config_set mine.*). */
export interface StairMineSettings {
  /** Dig a staircase mine near home when no ore with an open face is found. Default true. */
  enabled: boolean
  /** Dig down to this y (1.21: iron is most common around y 16, deepslate below 0). Default 16. */
  depthY: number
  /** The entrance is within this many blocks of home. Default 32. */
  radius: number
  /** ...and at least this far from home (out of the base). Default 8. */
  minFromHome: number
  /** One trip down lasts at most this long. Default 15. */
  minutes: number
  /** Side branches off the main tunnel, this long. Default 12. */
  branchLength: number
  /** Solid blocks between two branches (3 shows every ore block between them). Default 3. */
  branchSpacing: number
  /** Branch pairs per trip at most. Default 6. */
  maxBranches: number
  /** Head back up with fewer free inventory slots than this (after dropping junk). Default 3. */
  minFreeSlots: number
  /** Minutes between two trips down. Default 20. */
  cooldownMinutes: number
  /** Go down a lit mine at night too (the walk to the entrance is short). Default true. */
  atNight: boolean
  /** At night, with no mine yet, start one near home when it carries torches or makes them (it lights
   * the stairs as it digs, so the next night it is a lit mine). Default true. */
  startAtNight: boolean
  /** On the walk down a known mine, put torches on the dark stairs it passes (mining.torchEvery apart) when it has
   * or can make them, so an unlit mine becomes a lit one night trips may use. Default true. */
  relight: boolean
  /** Gear for its own mine (mining.gear is for caves and ore it walks to). Default none. */
  gear: MiningGear
  /** Health needed to go down. Default 14. */
  minHealth: number
  /** Cobblestone it keeps; more is dropped at the end of a branch. Default 64. */
  keepCobble: number
  /** Ores it mines when it sees them, by family. Default iron, coal, copper, diamond. */
  ores: string[]
}

export const STAIR_MINE_DEFAULTS: StairMineSettings = {
  enabled: true,
  depthY: 16,
  radius: 32,
  minFromHome: 8,
  minutes: 15,
  branchLength: 12,
  branchSpacing: 3,
  maxBranches: 6,
  minFreeSlots: 3,
  cooldownMinutes: 20,
  atNight: true,
  startAtNight: true,
  relight: true,
  gear: 'none',
  minHealth: 14,
  keepCobble: 64,
  ores: ['iron', 'coal', 'copper', 'diamond']
}

const GEARS: MiningGear[] = ['none', 'shield_or_armour', 'armour']

/** settings.mine over the defaults; wrong types fall back to the default. `mine: false` turns it off. */
export function stairMineSettings (raw: unknown): StairMineSettings {
  if (raw === false) return { ...STAIR_MINE_DEFAULTS, enabled: false }
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: StairMineSettings = { ...STAIR_MINE_DEFAULTS, ores: [...STAIR_MINE_DEFAULTS.ores] }
  for (const k of Object.keys(STAIR_MINE_DEFAULTS) as (keyof StairMineSettings)[]) {
    const v = o[k]
    if (v === undefined) continue
    if (k === 'gear') { if (GEARS.includes(v as MiningGear)) out.gear = v as MiningGear; continue }
    if (k === 'ores') { if (Array.isArray(v) && v.every(x => typeof x === 'string')) out.ores = v as string[]; continue }
    if (typeof v === typeof STAIR_MINE_DEFAULTS[k]) (out as unknown as Record<string, unknown>)[k] = v
  }
  return out
}

// ------------------------------------------------------------------ ores

/** Ore families: their blocks, what they drop, the pickaxe tier they need (1 wood, 2 stone, 3 iron). */
export const ORE_FAMILIES: Record<string, { blocks: string[], drop: string, tier: number }> = {
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], drop: 'coal', tier: 1 },
  iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], drop: 'raw_iron', tier: 2 },
  copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], drop: 'raw_copper', tier: 2 },
  lapis: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], drop: 'lapis_lazuli', tier: 2 },
  gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], drop: 'raw_gold', tier: 3 },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], drop: 'redstone', tier: 3 },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], drop: 'diamond', tier: 3 },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], drop: 'emerald', tier: 3 }
}

/** The ore family of a block name, or null. */
export function oreFamily (block: string): string | null {
  for (const [k, f] of Object.entries(ORE_FAMILIES)) if (f.blocks.includes(block)) return k
  return null
}

/** Whether to mine this ore block with this pickaxe tier (0 none .. 5 netherite), given the families wanted. */
export function oreWanted (block: string, pickTier: number, ores: readonly string[]): boolean {
  const k = oreFamily(block)
  return !!k && ores.includes(k) && pickTier >= ORE_FAMILIES[k]!.tier
}

const NEIGHBOURS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const key = (p: P) => `${p.x},${p.y},${p.z}`
const add = (p: P, dx: number, dy: number, dz: number): P => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz })

/**
 * Ore it can see from the tunnel: wanted ore blocks touching any of `spots` (tunnel air), and
 * the rest of each vein (ore touching ore, `veinMax` blocks per vein at most). Nearest first is
 * left to the caller. Pure.
 */
export function visibleOre (at: BlockLook, spots: readonly P[], pickTier: number, ores: readonly string[], veinMax = 12): P[] {
  const out: P[] = []
  const seen = new Set<string>(spots.map(key))
  const want = (p: P) => { const b = at(p); return !!b && oreWanted(b.name, pickTier, ores) }
  for (const s of spots) {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const p = add(s, dx, dy, dz)
      if (seen.has(key(p))) continue
      seen.add(key(p))
      if (!want(p)) continue
      // the vein, breadth first
      const vein = [p]
      for (let i = 0; i < vein.length && vein.length < veinMax; i++) {
        for (const [ex, ey, ez] of NEIGHBOURS) {
          const q = add(vein[i]!, ex, ey, ez)
          if (seen.has(key(q))) continue
          seen.add(key(q))
          if (want(q) && vein.length < veinMax) vein.push(q)
        }
      }
      out.push(...vein)
    }
  }
  return out
}

const AIR = /^(air|cave_air|void_air)$/

/**
 * The tunnel air around `from` (the bot in its own mine), so the cave check doesn't take the
 * tunnel it already dug on an earlier trip for a cave. Air connected to `from` within `radius`
 * blocks, `max` blocks at most. Pure.
 */
export function tunnelAir (at: BlockLook, from: P, radius = 5, max = 300): Set<string> {
  const out = new Set<string>()
  const queue: P[] = [from]
  while (queue.length && out.size < max) {
    const p = queue.shift()!
    if (out.has(key(p))) continue
    if (Math.max(Math.abs(p.x - from.x), Math.abs(p.y - from.y), Math.abs(p.z - from.z)) > radius) continue
    const b = at(p)
    if (!b || !(AIR.test(b.name) || /torch/.test(b.name))) continue
    out.add(key(p))
    for (const [dx, dy, dz] of NEIGHBOURS) queue.push(add(p, dx, dy, dz))
  }
  return out
}

// ------------------------------------------------------------------ readiness

/**
 * Fit to go down its own mine: a weapon (mining.needWeapon), mining.minFood food, mine.minHealth
 * health and the gear mine.gear asks for (none by default: the tunnel never opens into a cave).
 * Always ready with mining.safe off.
 */
export function stairMineReadiness (kit: Kit, health: number, s: StairMineSettings, m: MiningSettings): Readiness {
  if (!m.safe) return { ready: true, missing: [] }
  const missing: string[] = []
  let need: Readiness['need']
  if (m.needWeapon && !kit.weapon) { missing.push('no weapon'); need ??= 'weapon' }
  if (kit.food < m.minFood) { missing.push(kit.food ? `food ${kit.food}/${m.minFood}` : 'no food'); need ??= 'food' }
  if (health < s.minHealth) missing.push(`health ${Math.round(health)}/${s.minHealth}`)
  const armoured = kit.armour >= m.minArmour
  if (s.gear === 'shield_or_armour' && !armoured && !kit.shield) { missing.push('no shield or armour'); need ??= 'gear' }
  if (s.gear === 'armour' && !armoured) { missing.push(kit.armour ? `armour ${kit.armour}/${m.minArmour}` : 'no armour'); need ??= 'gear' }
  return { ready: missing.length === 0, missing, ...(need ? { need } : {}) }
}

// ------------------------------------------------------------------ where the mine goes

export interface Dir { x: number, z: number }

/** A spot the runner looked at for an entrance. */
export interface EntranceCandidate {
  /** Where the bot stands to dig the first step (feet). */
  pos: P
  dir: Dir
  /** Distance from home. */
  homeDist: number
  /** In a protected area, inside spawn protection or not the bot's to dig. */
  protectedArea?: boolean
  /** Water, ice or lava within a few blocks of the first steps. */
  wet?: boolean
  /** Something solid overhead (a roof, a build): not dug from inside a base. */
  roofed?: boolean
  /** On or next to a farm. */
  farm?: boolean
  /** Wrong for the base: too close to its walls, or inside when that isn't allowed (settings baseSafety.mineClearance, minePlacement). */
  base?: string
  /** How many of the first steps down plan safely (planStep). */
  safeSteps: number
}

/** How many of the first steps down must plan safely for an entrance. */
export const ENTRANCE_STEPS = 4

/** Why a candidate is no good, or null. Pure. */
export function entranceProblem (c: EntranceCandidate, s: Pick<StairMineSettings, 'radius' | 'minFromHome'>): string | null {
  if (c.homeDist > s.radius) return `more than ${s.radius} blocks from home`
  if (c.homeDist < s.minFromHome) return `closer than ${s.minFromHome} blocks to home`
  if (c.protectedArea) return 'protected'
  if (c.wet) return 'water, ice or lava close by'
  if (c.roofed) return 'under a roof'
  if (c.farm) return 'on a farm'
  if (c.base) return /from the base walls/.test(c.base) ? 'too close to the base walls' : c.base
  if (c.safeSteps < ENTRANCE_STEPS) return `only ${c.safeSteps} safe steps down`
  return null
}

/** The best entrance: no problem, nearest home first (then the most safe steps). Pure. */
export function pickEntrance (cands: readonly EntranceCandidate[], s: Pick<StairMineSettings, 'radius' | 'minFromHome'>): { pick: EntranceCandidate } | { none: string } {
  const good = cands.filter(c => !entranceProblem(c, s)).sort((a, b) => a.homeDist - b.homeDist || b.safeSteps - a.safeSteps)
  if (good[0]) return { pick: good[0] }
  if (!cands.length) return { none: 'no ground to dig into near home' }
  const why = new Map<string, number>()
  for (const c of cands) { const p = entranceProblem(c, s)!; why.set(p, (why.get(p) ?? 0) + 1) }
  const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`)
  return { none: `no spot for a mine within ${s.radius} blocks of home (${cands.length} looked at: ${top.join(', ')})` }
}

/** The y the stairs go down to: depthY, never closer than 6 to the world floor, never above the start. */
export function mineTargetY (startY: number, s: Pick<StairMineSettings, 'depthY'>, minY = -64): number {
  return Math.min(startY - 1, Math.max(minY + 6, s.depthY))
}

// ------------------------------------------------------------------ the trip

export type MinePhase = 'down' | 'main' | 'branch'

export interface TripState {
  phase: MinePhase
  y: number
  targetY: number
  /** ms since the trip started. */
  elapsedMs: number
  freeSlots: number
  /** Food items carried. */
  food: number
  /** A usable pickaxe is held. */
  pickaxe: boolean
  /** Ore items wanted and got on this trip (0 wanted = no target, mine until another limit). */
  want: number
  got: number
  /** Branch pairs dug on this trip. */
  branches: number
  /** Underground retreat reason (minePlan.undergroundRetreat), if any. */
  retreat?: string | null
}

/** Whether to carry on and what to do next, or head back up and why. Pure. */
export function mineTripStep (t: TripState, s: StairMineSettings): { go: MinePhase } | { back: string } {
  if (t.retreat) return { back: t.retreat }
  if (!t.pickaxe) return { back: 'no pickaxe left' }
  if (t.want > 0 && t.got >= t.want) return { back: `got the ${t.got} I came for` }
  if (t.elapsedMs >= s.minutes * 60_000) return { back: `${s.minutes} minutes are up` }
  if (t.freeSlots < s.minFreeSlots) return { back: 'inventory full' }
  if (t.food <= 0) return { back: 'out of food' }
  if (t.phase === 'down') return t.y > t.targetY ? { go: 'down' } : { go: 'main' }
  if (t.branches >= s.maxBranches) return { back: `dug ${t.branches} branches` }
  return { go: t.phase }
}

/** Main-tunnel steps between two branch points (the spacing plus the branch's own block). */
export function branchEvery (s: Pick<StairMineSettings, 'branchSpacing'>): number {
  return Math.max(1, s.branchSpacing + 1)
}

/** The two sides of a tunnel going `dir`: left, then right. */
export function sides (dir: Dir): [Dir, Dir] {
  return [{ x: dir.z + 0, z: -dir.x + 0 }, { x: -dir.z + 0, z: dir.x + 0 }]
}

/**
 * Stacks to drop to make room: cobblestone over keepCobble, then the usual mining junk (dirt,
 * gravel, granite, diorite, andesite, tuff, cobbled deepslate, netherrack...). Whole stacks,
 * smallest first. Pure.
 */
export function mineJunk (stacks: readonly { name: string, count: number }[], slots: number, keepCobble: number): { name: string, count: number }[] {
  if (slots <= 0) return []
  const JUNK: Record<string, number> = { cobblestone: keepCobble, dirt: 0, gravel: 0, granite: 0, diorite: 0, andesite: 0, tuff: 0, cobbled_deepslate: 16, calcite: 0, netherrack: 0, flint: 8 }
  const totals: Record<string, number> = {}
  for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count
  const out: { name: string, count: number }[] = []
  const order = Object.keys(JUNK)
  const cands = stacks.filter(st => JUNK[st.name] !== undefined)
    .sort((a, b) => (a.name === 'cobblestone' ? 1 : 0) - (b.name === 'cobblestone' ? 1 : 0) || order.indexOf(a.name) - order.indexOf(b.name) || a.count - b.count)
  for (const st of cands) {
    if (out.length >= slots) break
    if (totals[st.name]! - st.count < JUNK[st.name]!) continue
    out.push({ name: st.name, count: st.count })
    totals[st.name]! -= st.count
  }
  return out
}

// ------------------------------------------------------------------ the mine as a site

/** A mine it dug, as remembered in storage (`mines`). */
export interface MineSite {
  /** mine:N */
  id: string
  /** Where the stairs start (the bot's feet at the top). */
  entrance: P
  dir: Dir
  dim?: string
  /** The foot of the stairs, once it got to depth. */
  bottom?: P
  /** Where the main tunnel ends: the next trip carries on from here. */
  face?: P
  /** Direction of the main tunnel. */
  faceDir?: Dir
  /** Stair steps on the way down, every 4th, for walking it again. */
  path: P[]
  /** The first 3 stair steps (where the bot stood), for the site check. */
  start?: P[]
  /** Deepest y reached. */
  deepest: number
  /** Main-tunnel steps and branch pairs dug, over all trips. */
  mainSteps: number
  branches: number
  /** Torches placed in the stairs and tunnels. */
  torches: number
  /** Stair steps dug. */
  stairSteps: number
  trips: number
  lastAt: number
  /** What it got out of it, over all trips. */
  got: Record<string, number>
  /** A cap over the stairs where they cut the ground (base safety, near the base): taken off for a trip, put back after. */
  cap?: { cells: P[], kind: string, at: number }
}

/** Torches (carried, or 4 per coal and stick it could craft) it needs before it starts a mine at night. */
export const NIGHT_START_TORCHES = 8

/**
 * Whether a night trip down its own mine may go: down a known mine only when it is lit; with no
 * mine yet, a new one when mine.startAtNight is on and it has torches for the stairs (it lights
 * them as it digs, so from then on it is a lit mine). Without this a bot whose first mine never
 * got dug by day could never mine at night either.
 */
export function nightMineOk (o: { known: boolean, lit: boolean, torches: number, startAtNight: boolean }): boolean {
  if (o.known) return o.lit
  return o.startAtNight && o.torches >= NIGHT_START_TORCHES
}

/** A surface search that turned back for the light (sunset): the mine near home doesn't need it. */
export function turnedBackForLight (reason: unknown): boolean {
  return typeof reason === 'string' && /daylight|dark|night/i.test(reason)
}

/** The stair stands it remembers, in order down, with the stair step each one is: start (steps 1-3), then path (every 4th). */
export function stairPoints (m: Pick<MineSite, 'start' | 'path'>): { p: P, steps: number }[] {
  const out = (m.start ?? []).map((p, i) => ({ p, steps: i + 1 }))
  m.path.forEach((p, i) => out.push({ p, steps: 4 * (i + 1) }))
  return out
}

/**
 * Where to put torches on the walk down a mine's stairs. Pure. `points` are the stair stands in
 * order down with their step number and block light (undefined: unknown, not loaded). A stand
 * already lit (8+) restarts the count; else a torch goes where the dark run since the last light
 * reaches torchEvery steps (firstTorchAt for the first one in a mine with none). Returns indexes.
 */
export function relightSpots (points: readonly { steps: number, light?: number }[], o: { torchEvery: number, firstTorchAt?: number, torches: number }): number[] {
  const out: number[] = []
  if (o.torchEvery <= 0) return out
  let last = 0
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!
    if (pt.light === undefined) continue
    if (pt.light >= 8) { last = pt.steps; continue }
    const first = o.torches + out.length === 0
    const every = first && o.firstTorchAt && o.firstTorchAt > 0 ? Math.min(o.torchEvery, o.firstTorchAt) : o.torchEvery
    if (pt.steps - last >= every) { out.push(i); last = pt.steps }
  }
  return out
}

/** A mine counts as lit when the stairs have a torch about every mining.torchEvery steps. */
export function mineLit (m: Pick<MineSite, 'torches' | 'stairSteps'>, torchEvery: number): boolean {
  if (m.stairSteps <= 0) return false
  return m.torches >= Math.max(1, Math.floor(m.stairSteps / Math.max(1, torchEvery)) - 1)
}

/** The next free mine name past every one in use. */
export function nextMineName (names: readonly string[]): string {
  const max = names.reduce((m, n) => { const x = /^mine:(\d+)$/.exec(n); return x ? Math.max(m, Number(x[1])) : m }, 0)
  return `mine:${max + 1}`
}

/** Which remembered mine to use: same dimension, entrance within `radius` of home, not bad; the most worked first. Pure. */
export function pickMine (mines: readonly MineSite[], home: P | null, radius: number, dim: string | undefined, bad: (id: string) => boolean): MineSite | null {
  const ok = mines.filter(m => !bad(m.id) && (!m.dim || !dim || m.dim === dim) &&
    (!home || Math.hypot(m.entrance.x - home.x, m.entrance.z - home.z) <= radius + 8))
  return ok.sort((a, b) => (b.bottom ? 1 : 0) - (a.bottom ? 1 : 0) || b.mainSteps - a.mainSteps || b.lastAt - a.lastAt)[0] ?? null
}

/** Whether the next trip down is due (mine.cooldownMinutes since the last one ended). */
export function mineTripDue (lastEndedAt: number | undefined, now: number, s: Pick<StairMineSettings, 'cooldownMinutes'>): boolean {
  return !lastEndedAt || now - lastEndedAt >= s.cooldownMinutes * 60_000 || now < lastEndedAt
}

/** What a mine's entrance looks like now, for the site check. */
export interface MineEntranceLook {
  /** The blocks of the first stair steps: air (open), water/lava, or something solid. */
  steps: ('air' | 'water' | 'lava' | 'solid')[]
}

/** Is the mine still a mine: flooded (water or lava in the first steps), gone (the stairs filled in), else ok. Pure. */
export function mineSiteVerdict (look: MineEntranceLook): { ok: true, note?: string } | { ok: false, fault: 'flooded' | 'gone' | 'unsafe', reason: string } {
  if (!look.steps.length) return { ok: false, fault: 'gone', reason: 'no stairs where the mine was' }
  if (look.steps.includes('lava')) return { ok: false, fault: 'unsafe', reason: 'lava in the stairs' }
  if (look.steps.includes('water')) return { ok: false, fault: 'flooded', reason: 'water in the stairs' }
  const solid = look.steps.filter(x => x === 'solid').length
  if (solid * 2 > look.steps.length) return { ok: false, fault: 'gone', reason: `the stairs are filled in (${solid} of ${look.steps.length} blocks)` }
  return { ok: true }
}

// re-exported for the runner and tests
export type { MiningGear, MiningSettings, Kit, Readiness, BlockLook, P }
export const isAirName = (n: string) => AIR.test(n)
