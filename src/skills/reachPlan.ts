// Pure rules for the extra effort a hunt may spend on an animal the pathfinder can't reach on
// foot: bridging gaps and pillaring up with blocks from the inventory, digging down or through.
// No mineflayer here, so the decision and the budget are unit-tested; skills/combat.ts applies
// them to the pathfinder (helpers.reachMovements).

/** Blocks a bot may use for bridges and pillars, in order of preference (cheap first). */
export const SCAFFOLD_BLOCKS = [
  'dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
  'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks'
] as const

export interface ReachSituation {
  /** Digging and placing are allowed for this bot (settings). */
  canDig: boolean
  canPlace: boolean
  /** Scaffolding blocks carried (SCAFFOLD_BLOCKS). */
  scaffold: number
  /** Straight-line distance to the animal, and how far it is above (+) or below (-) the bot. */
  distance: number
  dy: number
  /** The animal stands in a protected area. */
  protectedTarget: boolean
  /** The animal (or the way to it) is in a remembered danger zone. */
  dangerTarget: boolean
  /** The animal stands in or right above water or lava (no digging down into that). */
  liquidAt?: 'water' | 'lava' | null
}

export interface ReachLimits {
  /** Blocks to place at most (bridges and pillars). Default 16. */
  maxBlocks: number
  /** Time for the extra effort. Default 45 s. */
  maxMs: number
  /** Further than this is not worth it. Default 48. */
  maxDistance: number
  /** More than this many blocks above or below is not worth it. Default 24. */
  maxDy: number
}

export const DEFAULT_REACH: ReachLimits = { maxBlocks: 16, maxMs: 45_000, maxDistance: 48, maxDy: 24 }

export interface ReachBudget {
  /** Blocks it may place (0 = no bridging or pillaring). */
  blocks: number
  /** May dig through or down. */
  dig: boolean
  /** May pillar straight up (needs blocks and a target above). */
  tower: boolean
  ms: number
}

export type ReachDecision = { ok: true, budget: ReachBudget, how: string } | { ok: false, reason: string }

/**
 * Whether to spend extra effort on an animal the pathfinder couldn't reach, and how much: place
 * up to maxBlocks scaffolding blocks (never more than it carries), dig when allowed, within a
 * time limit. Refused for protected areas, danger zones, animals in lava, too far or too deep,
 * and when it may neither dig nor place (or has nothing to place and may not dig).
 */
export function reachEffort (s: ReachSituation, l: Partial<ReachLimits> = {}): ReachDecision {
  const o = { ...DEFAULT_REACH, ...l }
  if (s.protectedTarget) return { ok: false, reason: 'it is in a protected area' }
  if (s.dangerTarget) return { ok: false, reason: 'it is in a remembered danger zone' }
  if (s.liquidAt === 'lava') return { ok: false, reason: 'it is by lava' }
  if (s.distance > o.maxDistance) return { ok: false, reason: `it is ${Math.round(s.distance)} blocks away (more than ${o.maxDistance})` }
  if (Math.abs(s.dy) > o.maxDy) return { ok: false, reason: `it is ${Math.abs(Math.round(s.dy))} blocks ${s.dy > 0 ? 'above' : 'below'} me (more than ${o.maxDy})` }
  const blocks = s.canPlace ? Math.max(0, Math.min(o.maxBlocks, Math.floor(s.scaffold))) : 0
  // digging down onto an animal standing in water would dig into the water
  const dig = s.canDig && !(s.liquidAt === 'water' && s.dy < 0)
  if (!blocks && !dig) {
    if (!s.canDig && !s.canPlace) return { ok: false, reason: 'I may neither dig nor place blocks' }
    if (s.canPlace && !s.scaffold && !s.canDig) return { ok: false, reason: 'no blocks to build with (dirt, cobblestone, planks) and digging is off' }
    return { ok: false, reason: s.liquidAt === 'water' ? 'it is down in water and I have no blocks to bridge with' : 'no blocks to build with and I may not dig' }
  }
  const tower = blocks > 0 && s.dy > 1
  const how = [blocks ? `up to ${blocks} blocks for ${tower ? 'a pillar or bridge' : 'a bridge'}` : '', dig ? 'digging' : ''].filter(Boolean).join(' and ')
  return { ok: true, budget: { blocks, dig, tower, ms: o.maxMs }, how }
}

/**
 * Whether breaking a block would open it onto water or lava below (digging straight down into a
 * liquid). `below` lists the names of the blocks under it, nearest first.
 */
export function digIntoLiquid (below: readonly (string | undefined)[]): boolean {
  return below.some(n => n === 'water' || n === 'lava' || n === 'flowing_water' || n === 'flowing_lava' || n === 'bubble_column')
}
