// Efficiency helpers: wood accounting (were all felled logs collected?), timing stats
// (blocks per minute) and small pure planners used by gathering. Pure where possible, unit tested.
import type { Bot } from 'mineflayer'
import { itemName } from '../core/index.ts'
import { planksFor } from './toolkit.ts'

/** Plank cost of wooden things the bot may have crafted from its logs (for accounting). */
const PLANK_VALUE: Record<string, number> = {
  stick: 0.5,
  crafting_table: 4,
  chest: 8,
  wooden_pickaxe: 4,
  wooden_axe: 4,
  wooden_sword: 2.5,
  wooden_shovel: 2,
  wooden_hoe: 3,
  // stone/iron tools still use wood for their sticks
  stone_pickaxe: 1,
  stone_axe: 1,
  stone_shovel: 1,
  stone_sword: 0.5,
  stone_hoe: 1,
  iron_pickaxe: 1,
  iron_axe: 1,
  iron_shovel: 1,
  iron_sword: 0.5,
  diamond_pickaxe: 1,
  diamond_axe: 1,
  diamond_shovel: 1,
  diamond_sword: 0.5,
  charcoal: 0 // counted separately: one log each
}

/** Wood held, in plank units: logs (4), planks, and wooden items made from them. */
export function woodUnits (inv: Record<string, number>): number {
  let n = 0
  for (const [k, v] of Object.entries(inv)) {
    if (/_planks$/.test(k)) n += v
    else if (planksFor(k)) n += 4 * v
    else if (/_(door)$/.test(k) && k !== 'iron_door') n += 2 * v
    else if (/_(trapdoor)$/.test(k) && k !== 'iron_trapdoor') n += 3 * v
    else if (k === 'charcoal') n += 4 * v
    else if (PLANK_VALUE[k] !== undefined) n += PLANK_VALUE[k]! * v
  }
  return n
}

export interface WoodBalance {
  /** Logs this bot broke. */
  broken: number
  /** Logs worth of wood that ended up in the inventory (as logs, planks, sticks, tools...). */
  kept: number
  /** broken - kept, never below 0. Logs used up by the furnace as fuel are not counted as lost by callers that pass `burned`. */
  lost: number
}

/**
 * Compares logs broken with the wood the inventory gained between two snapshots. `burned` is
 * logs or planks (in logs) knowingly spent as fuel. Pure.
 */
export function woodBalance (dug: Record<string, number>, before: Record<string, number>, after: Record<string, number>, burned = 0): WoodBalance {
  const broken = Object.entries(dug).reduce((n, [k, v]) => n + (isLogBlock(k) ? v : 0), 0)
  const kept = Math.round(((woodUnits(after) - woodUnits(before)) / 4 + burned) * 10) / 10
  return { broken, kept, lost: Math.max(0, Math.round((broken - kept) * 10) / 10) }
}

/** A natural log/stem block (what fellTree breaks). */
export function isLogBlock (name: string): boolean {
  return !name.startsWith('stripped_') && /_(log|stem|wood|hyphae)$/.test(name) && name !== 'mushroom_stem'
}

/** Blocks per minute, rounded to one decimal; 0 when nothing was broken. */
export function perMinute (count: number, ms: number): number {
  if (count <= 0 || ms <= 0) return 0
  return Math.round(count / (ms / 60_000) * 10) / 10
}

export interface MaterialWorld {
  /** Blocks of the material role still to place. */
  need: number
  /** Wood held in plank units (logs count 4). */
  planks: number
  /** Cobblestone (or cobbled deepslate) held. */
  cobble: number
  /** Natural trees within the gathering radius. */
  trees: number
  /** Natural stone within reach of a short walk or a staircase. */
  stone: boolean
  /** Holds any pickaxe (or has the wood for one). */
  pickaxe: boolean
}

/** Planks a typical tree gives (5-8 logs). Used to judge "few trees". */
export const PLANKS_PER_TREE = 24
/** With trees and stone both plentiful and a pickaxe at hand: the faster one, from live runs (see docs/guide/progression.md). */
const PREFER_WITH_PICKAXE: 'planks' | 'cobblestone' = 'cobblestone'

/**
 * Picks the cheaper wall material for a big build: whatever is already held, cobblestone when
 * there are too few trees around (and stone and a pickaxe), planks when there is no pickaxe or
 * no stone. With plenty of both, cobblestone once a pickaxe exists (a strip mine yields more
 * blocks per minute than felling and is not limited by trees), else planks. Pure.
 */
export function chooseWallMaterial (w: MaterialWorld): 'planks' | 'cobblestone' {
  if (w.planks >= w.need) return 'planks'
  if (w.cobble >= w.need) return 'cobblestone'
  if (!w.stone) return 'planks'
  if (!w.pickaxe) return 'planks'
  const treesNeeded = Math.ceil(Math.max(0, w.need - w.planks) / PLANKS_PER_TREE)
  if (w.trees < treesNeeded) return 'cobblestone'
  return PREFER_WITH_PICKAXE
}

// ------------------------------------------------------------------ inventory room

/** Items a working bot can throw away to make room, and how many of each it keeps. */
export const JUNK_KEEP: Record<string, number> = {
  rotten_flesh: 0,
  poisonous_potato: 0,
  dead_bush: 0,
  short_grass: 0,
  tall_grass: 0,
  fern: 0,
  snowball: 0,
  pointed_dripstone: 0,
  wheat_seeds: 16,
  beetroot_seeds: 8,
  spruce_sapling: 8,
  oak_sapling: 8,
  birch_sapling: 8,
  jungle_sapling: 8,
  acacia_sapling: 8,
  dark_oak_sapling: 8,
  cherry_sapling: 8,
  mangrove_propagule: 8,
  dirt: 64,
  gravel: 16,
  andesite: 0,
  diorite: 0,
  granite: 0,
  tuff: 0,
  cobbled_deepslate: 64,
  flint: 16
}

/**
 * Which junk stacks to throw away to free `slots` inventory slots: [item, count] pairs, the
 * least useful first, never more than the excess over what JUNK_KEEP keeps. `protect` names
 * items the current job needs (they are never thrown). Pure.
 */
export function junkToToss (stacks: { name: string, count: number }[], slots: number, protect: Set<string> = new Set()): { name: string, count: number }[] {
  if (slots <= 0) return []
  const out: { name: string, count: number }[] = []
  const totals: Record<string, number> = {}
  for (const s of stacks) totals[s.name] = (totals[s.name] ?? 0) + s.count
  const order = Object.keys(JUNK_KEEP)
  const candidates = stacks.filter(s => JUNK_KEEP[s.name] !== undefined && !protect.has(s.name))
    .sort((a, b) => JUNK_KEEP[a.name]! - JUNK_KEEP[b.name]! || order.indexOf(a.name) - order.indexOf(b.name) || a.count - b.count)
  let freed = 0
  for (const s of candidates) {
    if (freed >= slots) break
    const excess = totals[s.name]! - JUNK_KEEP[s.name]!
    if (excess < s.count) continue // tossing this whole stack would go below the keep amount
    out.push({ name: s.name, count: s.count })
    totals[s.name]! -= s.count
    freed++
  }
  return out
}

/**
 * Makes sure at least `slots` inventory slots are free by throwing away junk (see JUNK_KEEP).
 * Crafting into a full inventory makes mineflayer toss the result (or the ingredient stack on
 * the cursor) onto the ground, and a full inventory can't pick up drops. Returns what it threw.
 */
export async function makeRoom (bot: Bot, slots: number, protect: Set<string> = new Set()): Promise<string> {
  const free = bot.inventory.emptySlotCount()
  if (free >= slots) return ''
  const stacks = bot.inventory.items().map(i => ({ name: itemName(i), count: i.count, item: i }))
  const toss = junkToToss(stacks, slots - free, protect)
  const thrown: string[] = []
  for (const t of toss) {
    const it = stacks.find(s => s.name === t.name && s.count === t.count && bot.inventory.slots[s.item.slot] === s.item)
    if (!it) continue
    try { await bot.tossStack(it.item); thrown.push(`${t.count} ${t.name}`) } catch {}
  }
  return thrown.join(', ')
}

/** Item entities within `radius` of the bot (their ids). */
export function dropsNear (bot: Bot, radius: number): Set<number> {
  return new Set(Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= radius).map(e => e.id))
}
