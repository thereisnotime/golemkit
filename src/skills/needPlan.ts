// Pure answers to "how urgent is this need" and "is this site still any good" for the Minecraft
// needs provider (src/adapters/minecraft-java/needs/). No mineflayer here: unit-tested in
// test/need-plan.test.ts.
import type { SiteVerdict } from '../core/sites.ts'
import { heldTier, ARMOUR } from './progression.ts'
import type { ToolKind } from './toolkit.ts'

const TIER: Record<string, number> = { none: 0, wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

export interface GearState {
  /** Items carried and worn, by name. */
  held: Record<string, number>
  /** Tier the tools should reach. */
  upTo: 'stone' | 'iron' | 'diamond'
  /** Iron armour is part of the target. */
  armour: boolean
}

/** Any helmet/chestplate/leggings/boots of iron or better counts for its slot. */
const SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'] as const
const GOOD_ARMOUR = /^(iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/

/**
 * Gear urgency, 0..1, and what is missing. No weapon (sword or axe) or no pickaxe 0.8; a pickaxe
 * below the target tier 0.5, other tools below it 0.35; armour: 0.3 plus 0.075 per missing slot
 * (no armour at all: 0.6). The largest applies.
 */
export function gearUrgency (s: GearState): { urgency: number, missing: string[] } {
  const target = TIER[s.upTo]!
  const missing: string[] = []
  let u = 0
  const tier = (k: ToolKind) => TIER[heldTier(s.held, k)] ?? 0
  if (tier('sword') === 0 && tier('axe') === 0) { missing.push('a weapon'); u = Math.max(u, 0.8) }
  if (tier('pickaxe') === 0) { missing.push('a pickaxe'); u = Math.max(u, 0.8) } else if (tier('pickaxe') < target) { missing.push(`a ${s.upTo} pickaxe`); u = Math.max(u, 0.5) }
  for (const k of ['sword', 'axe'] as ToolKind[]) {
    if (tier(k) > 0 && tier(k) < target) { missing.push(`a ${s.upTo} ${k}`); u = Math.max(u, 0.35) }
  }
  if (s.armour) {
    const have = new Set(Object.keys(s.held).filter(n => (s.held[n] ?? 0) > 0 && GOOD_ARMOUR.test(n)).map(n => n.split('_')[1]))
    const gone = SLOTS.filter(x => !have.has(x))
    if (gone.length) { missing.push(`iron ${gone.join(', ')}`); u = Math.max(u, 0.3 + 0.075 * gone.length) }
  }
  return { urgency: Math.min(1, u), missing }
}

/** Iron ingots the missing iron gear still needs (for the search's count). */
export function ironWanted (s: GearState): number {
  let n = 0
  if (TIER[s.upTo]! >= 3) {
    const heads: Record<string, number> = { pickaxe: 3, sword: 2, axe: 3, shovel: 1 }
    for (const [k, c] of Object.entries(heads)) if ((TIER[heldTier(s.held, k as ToolKind)] ?? 0) < 3) n += c
  }
  if (s.armour) for (const [a, c] of Object.entries(ARMOUR)) if (!Object.keys(s.held).some(h => (s.held[h] ?? 0) > 0 && GOOD_ARMOUR.test(h) && h.endsWith(a.split('_')[1]!))) n += c
  return n
}

export interface SuppliesState {
  /** Logs, plus planks / 4. */
  wood: number
  /** Wood it wants in stock. */
  woodKeep: number
  /** Food items in the pantry and its own chests as remembered, or null when it doesn't know. */
  storedFood: number | null
  /** Below this stored food it says the pantry is low (inventoryMemory.lowFood). */
  lowFood: number
  /** Seeds carried and stored, and whether it has a farm to plant them on. */
  seeds: number
  hasFarm: boolean
}

/** How much the base is short of, 0..1: wood under half the stock 0.4 (none 0.6), a low pantry 0.5, a farm with under 4 seeds 0.3. */
export function suppliesUrgency (s: SuppliesState): { urgency: number, short: string[] } {
  const short: string[] = []
  let u = 0
  if (s.wood < s.woodKeep / 2) { short.push(`wood (${s.wood}/${s.woodKeep})`); u = Math.max(u, s.wood === 0 ? 0.6 : 0.4) }
  if (s.storedFood !== null && s.lowFood > 0 && s.storedFood < s.lowFood) { short.push(`stored food (${s.storedFood}/${s.lowFood})`); u = Math.max(u, 0.5) }
  if (s.hasFarm && s.seeds < 4) { short.push(`seeds (${s.seeds})`); u = Math.max(u, 0.3) }
  return { urgency: u, short }
}

/** What one cell of a farm square holds, for the site check. */
export type FarmSiteCell = 'farmland' | 'tillable' | 'water' | 'ice' | 'other'

/**
 * Whether a farm is still a farm. Pure. Flooded: half or more of the cells (the middle water
 * block left out) are water or ice, or the middle froze and a quarter is wet. No work: no
 * farmland and nothing it could till. Otherwise ok, also with nothing ripe (a growing farm
 * has no work and is fine).
 */
export function farmSiteVerdict (cells: Record<string, FarmSiteCell>, land?: readonly string[]): SiteVerdict {
  const centreIce = cells['0,0'] === 'ice'
  // a shore farm: only the cells that were land when it was made count (the lake side was
  // always water, which used to mark every shore farm flooded on its first check)
  const keys = land?.length ? new Set(land.filter(k => k !== '0,0' && k in cells)) : null
  const entries = Object.entries(cells).filter(([k]) => k !== '0,0' && (!keys || keys.has(k)))
  const n = entries.length
  if (!n) return { ok: false, fault: 'gone', reason: 'no ground where the farm was' }
  const wet = entries.filter(([, v]) => v === 'water' || v === 'ice').length
  const ice = entries.filter(([, v]) => v === 'ice').length
  const farmland = entries.filter(([, v]) => v === 'farmland').length
  const tillable = entries.filter(([, v]) => v === 'tillable').length
  if (keys && centreIce) return { ok: false, fault: 'flooded', reason: `the water froze (${farmland} farmland left dry)` }
  if (wet * 2 >= n || (centreIce && wet * 4 >= n)) {
    return { ok: false, fault: 'flooded', reason: `${wet} of ${n} cells are ${ice ? (ice === wet ? 'ice' : 'water or ice') : 'water'}${centreIce ? ', the water froze' : ''}` }
  }
  if (!farmland && !tillable) return { ok: false, fault: 'no_work', reason: `no farmland and nothing to till (${n} cells)` }
  return { ok: true, note: `${farmland} farmland, ${tillable} tillable` }
}

/** The next free farm name: farm:N past every name in use (live farms and bad site records). */
export function nextFarmName (names: readonly string[]): string {
  const max = names.reduce((m, n) => { const x = /^farm:(\d+)$/.exec(n); return x ? Math.max(m, Number(x[1])) : m }, 0)
  return `farm:${max + 1}`
}

/** Water freezes in biomes this cold or colder (vanilla: temperature below 0.15 at the surface). */
export const FREEZE_TEMPERATURE = 0.15

/** A farm site candidate near a bad farm (inside its plot plus `margin`) is skipped. */
export function nearBadSite (p: { x: number, z: number }, bad: readonly { x: number, z: number, size?: number }[], margin = 8): boolean {
  return bad.some(b => Math.max(Math.abs(p.x - b.x), Math.abs(p.z - b.z)) <= ((b.size ?? 9) - 1) / 2 + margin)
}

/** A spare to craft from what it carries, or null: torches below 16 with coal and a stick's worth of wood, a second stone pickaxe from 3 cobblestone. */
export function spareCraft (inv: Record<string, number>): { item: string, count: number } | null {
  const planks = Object.entries(inv).filter(([k]) => k.endsWith('_planks')).reduce((n, [, v]) => n + v, 0)
  const sticks = inv.stick ?? 0
  const fuel = (inv.coal ?? 0) + (inv.charcoal ?? 0)
  const torches = inv.torch ?? 0
  if (torches < 16 && fuel > 0 && (sticks > 0 || planks >= 2)) return { item: 'torch', count: Math.min(16 - torches, Math.min(fuel, 4) * 4) }
  const picks = Object.entries(inv).filter(([k]) => k.endsWith('_pickaxe')).reduce((n, [, v]) => n + v, 0)
  if (picks === 1 && (inv.stone_pickaxe ?? 0) + (inv.iron_pickaxe ?? 0) + (inv.diamond_pickaxe ?? 0) > 0 && (inv.cobblestone ?? 0) >= 3 && (sticks >= 2 || planks >= 2)) {
    return { item: 'stone_pickaxe', count: 1 }
  }
  return null
}
