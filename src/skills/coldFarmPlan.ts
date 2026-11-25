// Farming on cold ground without a bucket (pure, unit-tested in test/cold-farm-plan.test.ts).
// food.ts reads the world into these and does the digging and placing.
//
// The 1.21.1 rules this relies on (IceBlock, Biome.shouldFreeze; checked against the wiki):
// - Ice broken without Silk Touch turns into a water source when the block under it blocks
//   movement or is a fluid (a lake under the ice counts); over air it just vanishes, and in the
//   Nether (ultrawarm) it never makes water. Any tool or a bare hand will do.
// - Ice melts on a random tick when the block light next to it is above 11 (12+), in any biome;
//   sky light doesn't count. Slow (about a minute per block on average) and it melts the lake
//   around it too, so breaking is the way to get water now; light is a way to keep it.
// - Water freezes in a cold biome only when it is the top block under the sky (nothing that
//   blocks movement above it), its block light is below 10, and it has a non-water block next to
//   it. So a block (or slab) over the water stops it, and so does a torch close enough to give
//   it light 10+ (a torch is 14 at its own block, one less per block of distance).
// - Crops grow in snowy biomes (light 9+ and wet farmland is all they need); snow never settles
//   on farmland or on crops.

/** Water with at least this much block light never freezes. */
export const NO_FREEZE_LIGHT = 10
/** Ice next to more than this much block light melts. */
export const MELT_LIGHT = 11
/** Light a torch gives at its own block. */
export const TORCH = 14

/** Blocks under ice that make it turn into water when broken: anything that blocks movement, or a fluid. */
export function iceMakesWater (o: { below: string, belowSolid: boolean, nether?: boolean, silkTouch?: boolean }): boolean {
  if (o.nether || o.silkTouch) return false
  return o.belowSolid || o.below === 'water' || o.below === 'lava' || o.below === 'bubble_column'
}

/** Whether exposed water at this spot would freeze again (1.21.1 Biome.shouldFreeze). */
export function waterFreezes (o: { cold: boolean, covered: boolean, blockLight: number, surroundedByWater?: boolean }): boolean {
  if (!o.cold || o.covered) return false
  if (o.blockLight >= NO_FREEZE_LIGHT) return false
  return !o.surroundedByWater
}

/** Block light a torch gives at a block `d` steps away (Manhattan, through air). */
export function torchLightAt (d: number): number {
  return Math.max(0, TORCH - d)
}

/** Blocks good for covering water (cheap, full, don't fall, nothing valuable). Best first. */
export const COVER_BLOCKS = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'netherrack', 'sandstone']
const PLANKS = /_planks$/

/** The cover block to use from what it carries (needs 2: one stays over the water, one is a helper it takes back). */
export function coverItem (inv: Record<string, number>, need = 2): string | null {
  for (const n of COVER_BLOCKS) if ((inv[n] ?? 0) >= need) return n
  const p = Object.keys(inv).filter(k => PLANKS.test(k) && (inv[k] ?? 0) >= need).sort()[0]
  return p ?? null
}

export type ProtectMode = 'auto' | 'cover' | 'torch' | 'off'

export interface ProtectInput {
  /** The water would freeze without help (cold biome, open sky, little block light). */
  freezes: boolean
  mode: ProtectMode
  /** A cover block it carries (coverItem), or null. */
  cover: string | null
  /** Torches carried, or that it can make right away. */
  torches: number
  /** A ground cell next to the water where a helper block or a torch can stand. */
  side: boolean
}

export interface Protection {
  how: 'none' | 'cover' | 'torch'
  /** Usable: the water stays water (or doesn't need help). */
  ok: boolean
  reason: string
}

/**
 * How to keep a farm's water from freezing. A block over the water is the sure way (and costs
 * only a cheap block); a torch next to it gives the water light 12 and lights the field too. In
 * auto: cover, else a torch. Nothing needed when it doesn't freeze.
 */
export function protectionFor (p: ProtectInput): Protection {
  if (!p.freezes) return { how: 'none', ok: true, reason: 'the water does not freeze here' }
  if (p.mode === 'off') return { how: 'none', ok: false, reason: 'the water would freeze and farming.protectWater is off' }
  if (!p.side) return { how: 'none', ok: false, reason: 'the water would freeze and there is no ground next to it to work from' }
  const cover = p.cover && (p.mode === 'auto' || p.mode === 'cover')
  const torch = p.torches > 0 && (p.mode === 'auto' || p.mode === 'torch')
  if (cover) return { how: 'cover', ok: true, reason: `a ${p.cover} over the water keeps it from freezing` }
  if (torch) return { how: 'torch', ok: true, reason: 'a torch next to the water keeps it from freezing (light 12)' }
  const missing = p.mode === 'cover' ? 'two cheap blocks (dirt, cobblestone)' : p.mode === 'torch' ? 'a torch' : 'two cheap blocks or a torch'
  return { how: 'none', ok: false, reason: `the water would freeze again and I have no ${missing} to keep it open` }
}

export interface IceCandidate {
  x: number
  y: number
  z: number
  /** Block above the ice (air or snow: open, it can be reached and worked from the top). */
  above: string
  /** Block under it, and whether it blocks movement. */
  below: string
  belowSolid: boolean
  /** Sky light above it (0 under a roof); null when the server sends no light. */
  sky: number | null
}

/** An ice block that would make a usable water source: open above, water or ground under it. */
export function iceSourceOk (c: IceCandidate, o: { nether?: boolean } = {}): boolean {
  if (!/^(air|snow|cave_air)$/.test(c.above)) return false
  if (c.sky !== null && c.sky < 10) return false
  return iceMakesWater({ below: c.below, belowSolid: c.belowSolid, nether: o.nether })
}

export type ColdStep = 'take_blocks' | 'break_ice' | 'cover' | 'torch'

export interface ColdWaterPlan {
  ok: boolean
  steps: ColdStep[]
  protection: Protection
  reason: string
}

/**
 * The steps to get a farm water source at a site in the cold, without a bucket: break the ice
 * (when the centre is ice) and keep the water from freezing (protectionFor), taking two cheap
 * blocks from its chests first when it has none and a cover is the plan.
 */
export function planColdWater (o: {
  centre: 'ice' | 'water'
  freezes: boolean
  mode: ProtectMode
  inv: Record<string, number>
  /** Cheap blocks in its chests near home (for a cover when it carries none). */
  stored?: Record<string, number>
  torches: number
  side: boolean
  iceWater: boolean
}): ColdWaterPlan {
  if (o.centre === 'ice' && !o.iceWater) return { ok: false, steps: [], protection: { how: 'none', ok: false, reason: '' }, reason: 'the water is frozen and farming.iceWater is off' }
  let cover = coverItem(o.inv)
  let take = false
  if (!cover && (o.mode === 'auto' || o.mode === 'cover') && !(o.mode === 'auto' && o.torches > 0) && o.stored) {
    cover = coverItem(o.stored)
    take = !!cover
  }
  const protection = protectionFor({ freezes: o.freezes, mode: o.mode, cover, torches: o.torches, side: o.side })
  if (!protection.ok) return { ok: false, steps: [], protection, reason: protection.reason }
  const steps: ColdStep[] = []
  if (take && protection.how === 'cover') steps.push('take_blocks')
  if (o.centre === 'ice') steps.push('break_ice')
  if (protection.how === 'cover') steps.push('cover')
  if (protection.how === 'torch') steps.push('torch')
  const what = o.centre === 'ice' ? 'break the ice for water' : 'use the open water'
  return { ok: true, steps, protection, reason: `${what}; ${protection.reason}` }
}

/**
 * The ground cell next to the water to work from (helper block for the cover, or the torch):
 * the cardinal neighbour that is tillable, so it is on the shore and not on the lake.
 * Keys are "dx,dz" from the water.
 */
export function sideCell (cells: Record<string, string>): [number, number] | null {
  for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    if (cells[`${dx},${dz}`] === 'tillable') return [dx, dz]
  }
  return null
}

export interface FarmingSettings {
  /** Break ice on a frozen shore (or pond) to get a farm's water when there is no open water or bucket. */
  iceWater: boolean
  /** How to keep a farm's water from freezing in a cold biome. */
  protectWater: ProtectMode
}

export const FARMING_DEFAULTS: FarmingSettings = { iceWater: true, protectWater: 'auto' }

/** settings.farming with defaults; `farming: false` switches the cold-ground tricks off. */
export function farmingSettings (raw: unknown): FarmingSettings {
  if (raw === false) return { iceWater: false, protectWater: 'off' }
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const mode = o.protectWater
  return {
    iceWater: typeof o.iceWater === 'boolean' ? o.iceWater : FARMING_DEFAULTS.iceWater,
    protectWater: mode === 'auto' || mode === 'cover' || mode === 'torch' || mode === 'off' ? mode : mode === false ? 'off' : FARMING_DEFAULTS.protectWater
  }
}
