// Safe mining planner, pure and unit tested (test/mine-plan.test.ts). Decides whether the bot
// is ready to go underground (weapon, food, gear), how deep it may dig, whether a block it is
// about to break opens into a cave, when to light the tunnel, and when to abandon a dig and
// head back up. mining.ts, progression.ts, gather.ts and the reflexes call it; nothing here
// touches mineflayer.
//
// Pax died at y 10 with stone tools, no armour and no torches: upgrade_tools walked it into a
// cave after exposed iron ore, it stood and fought a creeper and a zombie at 8 health and lost
// everything. The rules below are the answer to that run.

export interface P { x: number, y: number, z: number }
/** What the planner needs to know about a block; null when the chunk is not loaded. `sky` is the sky light (0-15) when known. */
export type BlockLook = (p: P) => { name: string, solid: boolean, sky?: number } | null

export type MiningGear = 'none' | 'shield_or_armour' | 'armour'

/** settings.mining (profile `settings: mining:`, live with config_set mining.*). */
export interface MiningSettings {
  /** Gate going deep on readiness, avoid caves, light tunnels, retreat underground. Default true. */
  safe: boolean
  /** Blocks below the surface the bot may dig or walk to without the readiness check. Default 8. */
  safeDepth: number
  /** Needs a sword or axe to go deeper. Default true. */
  needWeapon: boolean
  /** Food items needed to go deeper. Default 3. */
  minFood: number
  /** Gear needed to go deeper: none, a shield or armour, or armour. Default none. */
  gear: MiningGear
  /** Armour points that count as "armour" for `gear`. Default 1 (any piece). */
  minArmour: number
  /** Underground: abandon the dig and climb out at or below this health (0 = never). Default 10. */
  retreatBelow: number
  /** Underground: abandon the dig and climb out when this many hostiles are close (0 = never). Default 2. */
  retreatHostiles: number
  /** How close a hostile counts for retreatHostiles, in blocks. Default 8. */
  hostileRadius: number
  /**
   * Hostiles standing under open sky (on the surface above the mine) count for retreatHostiles
   * too. Default false: at night the zombies walking over a mine entrance sent the first trip back
   * up after 5 steps. One within hostileClose counts either way.
   */
  surfaceHostiles: boolean
  /** A hostile this close (blocks) counts wherever it stands. Default 4. */
  hostileClose: number
  /** Light the tunnel with torches (crafted from coal or charcoal and sticks when it has none). Default true. */
  torches: boolean
  /** A torch every this many tunnel steps. Default 8. */
  torchEvery: number
  /** In a mine with no torch yet, the first one goes after this many steps (the stairs down from the entrance are dark at night). Default 4. */
  firstTorchAt: number
}

export const MINING_DEFAULTS: MiningSettings = {
  safe: true,
  safeDepth: 8,
  needWeapon: true,
  minFood: 3,
  gear: 'none',
  minArmour: 1,
  retreatBelow: 10,
  retreatHostiles: 2,
  hostileRadius: 8,
  surfaceHostiles: false,
  hostileClose: 4,
  torches: true,
  torchEvery: 8,
  firstTorchAt: 4
}

const GEARS: MiningGear[] = ['none', 'shield_or_armour', 'armour']

/** settings.mining merged over the defaults; wrong types fall back to the default. */
export function miningSettings (raw: unknown): MiningSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: MiningSettings = { ...MINING_DEFAULTS }
  for (const k of Object.keys(MINING_DEFAULTS) as (keyof MiningSettings)[]) {
    const v = o[k]
    if (v === undefined) continue
    if (k === 'gear') { if (GEARS.includes(v as MiningGear)) out.gear = v as MiningGear; continue }
    if (typeof v === typeof MINING_DEFAULTS[k]) (out as unknown as Record<string, unknown>)[k] = v
  }
  return out
}

/** What the bot carries, for readiness. */
export interface Kit {
  /** A sword or axe. */
  weapon: boolean
  /** Food items (any edible, not rotten flesh or poison). */
  food: number
  /** Armour points worn. */
  armour: number
  /** A shield in the inventory or offhand. */
  shield: boolean
  torches?: number
}

export interface Readiness {
  ready: boolean
  /** What is missing, short ("no weapon", "food 1/3", "no shield or armour"). */
  missing: string[]
  /** Which need would fix it first: weapon, food, gear. */
  need?: 'weapon' | 'food' | 'gear'
}

/** Is the bot fit to go below the safe depth or into caves? Always ready with mining.safe off. */
export function miningReadiness (kit: Kit, s: MiningSettings): Readiness {
  if (!s.safe) return { ready: true, missing: [] }
  const missing: string[] = []
  let need: Readiness['need']
  if (s.needWeapon && !kit.weapon) { missing.push('no weapon'); need ??= 'weapon' }
  if (kit.food < s.minFood) { missing.push(kit.food ? `food ${kit.food}/${s.minFood}` : 'no food'); need ??= 'food' }
  const armoured = kit.armour >= s.minArmour
  if (s.gear === 'shield_or_armour' && !armoured && !kit.shield) { missing.push('no shield or armour'); need ??= 'gear' }
  if (s.gear === 'armour' && !armoured) { missing.push(kit.armour ? `armour ${kit.armour}/${s.minArmour}` : 'no armour'); need ??= 'gear' }
  return { ready: missing.length === 0, missing, ...(need ? { need } : {}) }
}

/** "not ready to mine: no armour, no food". */
export function notReadyText (r: Readiness): string {
  return `not ready to mine: ${r.missing.join(', ')}`
}

/** True when this armour/shield gap is the only thing missing and a shield (1 iron ingot) would close it. */
export function shieldWouldDo (kit: Kit, s: MiningSettings): boolean {
  return s.safe && s.gear === 'shield_or_armour' && !kit.shield && kit.armour < s.minArmour
}

const AIR = /^(air|cave_air|void_air)$/
const SURFACE_SKIP = /leaves|_log$|_wood$|vine|snow$|^snow_layer$|glass/

/**
 * The surface over a spot: one above the highest solid ground block in the column within
 * `range` blocks up (leaves, logs and glass don't count). The spot itself when the sky is open.
 */
export function surfaceAbove (at: BlockLook, p: P, range = 48): number {
  let top = p.y - 1
  for (let dy = 1; dy <= range; dy++) {
    const b = at({ x: p.x, y: p.y + dy, z: p.z })
    if (!b) break
    if (b.solid && !SURFACE_SKIP.test(b.name)) top = p.y + dy
  }
  return Math.max(p.y, top + 1)
}

/**
 * How deep a target is for the readiness rule: the larger of how far below the bot's surface
 * level it sits and how much ground covers it. Positive = below.
 */
export function targetDepth (refSurfaceY: number, target: P, surfaceOverTarget: number): number {
  return Math.max(refSurfaceY - target.y, surfaceOverTarget - target.y)
}

/** May the bot go for something this deep? */
export function depthAllowed (depth: number, ready: boolean, s: MiningSettings): boolean {
  return !s.safe || ready || depth <= s.safeDepth
}

const NEIGHBOURS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const key = (p: P) => `${p.x},${p.y},${p.z}`

/**
 * Would breaking these blocks open the tunnel into a cave or an air pocket? Air next to a dug
 * block counts unless it is part of the tunnel (`open`), lies above `belowY` (the surface,
 * where the staircase starts in the open), or has full sky light (a ravine or cliff face open
 * to the sky). Also a floor with air right under it (a thin crust over a cave). Returns the
 * reason or null.
 */
export function caveHazard (at: BlockLook, dig: P[], stand: P, open: Set<string>, belowY: number): string | null {
  const opened = new Set([...open, ...dig.map(key)])
  const pocket = (q: P) => {
    if (opened.has(key(q)) || q.y >= belowY) return false
    const b = at(q)
    if (!b || !AIR.test(b.name)) return false
    return b.sky === undefined || b.sky < 15
  }
  for (const p of dig) {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
      if (pocket(q)) return `cave next to ${p.x} ${p.y} ${p.z}`
    }
  }
  const under = { x: stand.x, y: stand.y - 2, z: stand.z }
  if (pocket(under)) return `cave under ${stand.x} ${stand.y - 1} ${stand.z}`
  return null
}

/**
 * Time for a torch: every `torchEvery` steps (the first one in a mine with none yet after
 * `firstTorchAt`), unless the spot is already lit (block light 8+).
 */
export function torchDue (stepsSinceTorch: number, s: Pick<MiningSettings, 'torches' | 'torchEvery'> & { firstTorchAt?: number }, blockLight?: number, first = false): boolean {
  const every = first && s.firstTorchAt && s.firstTorchAt > 0 ? Math.min(s.torchEvery, s.firstTorchAt) : s.torchEvery
  if (!s.torches || s.torchEvery <= 0 || stepsSinceTorch < every) return false
  return blockLight === undefined || blockLight < 8
}

/** A hostile near the bot, as undergroundNow sees it. */
export interface HostileSeen {
  /** Distance in blocks. */
  dist: number
  /** Its height above (+) or below (-) the bot. */
  dy: number
  /** Standing under open sky (sky light 12+ where it stands): on the surface, not in the mine. */
  open?: boolean
}

/** Sky light at or above this where a mob stands: it is under open sky. */
export const OPEN_SKY_LIGHT = 12

/**
 * How many hostiles count for retreatHostiles: within hostileRadius and 8 blocks of height, and
 * either down here (not under open sky) or within hostileClose. With surfaceHostiles every one
 * in the radius counts. Pure.
 */
export function hostilesThatCount (list: readonly HostileSeen[], s: Pick<MiningSettings, 'hostileRadius' | 'surfaceHostiles' | 'hostileClose'>): number {
  return list.filter(h => h.dist <= s.hostileRadius && Math.abs(h.dy) < 8 &&
    (s.surfaceHostiles || !h.open || h.dist <= s.hostileClose)).length
}

/** Crafts of torches (4 each) possible from coal/charcoal and sticks or planks. */
export function torchCrafts (inv: Record<string, number>): number {
  const fuel = (inv.coal ?? 0) + (inv.charcoal ?? 0)
  const planks = Object.entries(inv).reduce((n, [k, v]) => n + (/_planks$/.test(k) ? v : 0), 0)
  const sticks = (inv.stick ?? 0) + 4 * Math.floor(planks / 2)
  return Math.min(fuel, sticks)
}

/** Underground, is the cover overhead real (not a house roof or a tree)? */
export function isUnderground (coverBlocks: number, skyLight?: number): boolean {
  return coverBlocks >= 3 && (skyLight === undefined || skyLight < 8)
}

export interface RetreatInput {
  underground: boolean
  health: number
  /** Hostiles within the radius. */
  hostiles: number
  /** Air left (0-20) when known: under water and running out drowns it (a live test bot did, at y 33). */
  air?: number
}

/** Underground and losing: why the bot should abandon the dig and head back up, or null to carry on. */
export function undergroundRetreat (i: RetreatInput, s: MiningSettings): string | null {
  if (!s.safe || !i.underground || i.health <= 0) return null
  if (i.air !== undefined && i.air <= 6) return 'running out of air underground'
  if (s.retreatBelow > 0 && i.health <= s.retreatBelow) return `health ${Math.round(i.health)}/20 underground`
  if (s.retreatHostiles > 0 && i.hostiles >= s.retreatHostiles) return `${i.hostiles} hostiles close underground`
  return null
}
