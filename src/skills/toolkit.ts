// Tool prerequisites: make sure the bot holds a usable axe/pickaxe/shovel/sword before work
// that needs one, crafting the best tier the inventory allows (planks from logs, sticks from
// planks, a crafting table when the recipe needs it). It never goes out to gather; callers
// that can gather (gather_materials) do that first.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { checkAborted, itemName, ok, fail, sleep, type ActionResult } from '../core/index.ts'
import { craftItem } from './crafting.ts'
import { countItem } from './world.ts'

export type ToolKind = 'axe' | 'pickaxe' | 'shovel' | 'sword' | 'hoe'
export type Tier = 'wooden' | 'stone' | 'iron' | 'diamond' | 'netherite'

/** Best first. Golden tools are left out on purpose (they break almost at once). */
export const TIERS: Tier[] = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
const RANK: Record<string, number> = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

/** Head material count and sticks per tool kind. */
export const TOOL_SHAPE: Record<ToolKind, { head: number, sticks: number }> = {
  axe: { head: 3, sticks: 2 },
  pickaxe: { head: 3, sticks: 2 },
  shovel: { head: 1, sticks: 2 },
  sword: { head: 2, sticks: 1 },
  hoe: { head: 2, sticks: 2 }
}

/** Items that can make a tool head of this tier (any wood for wooden, any cobble for stone). */
const HEAD: Record<Exclude<Tier, 'netherite'>, RegExp> = {
  wooden: /_planks$/,
  stone: /^(cobblestone|cobbled_deepslate|blackstone)$/,
  iron: /^iron_ingot$/,
  diamond: /^diamond$/
}

export function toolTier (name: string, kind: ToolKind): number {
  const m = new RegExp(`^(?:[a-z0-9_]+:)?([a-z]+)_${kind}$`).exec(name)
  return m ? (RANK[m[1]!] ?? 1) : 0
}

/** The best tool of a kind among item names, or null. Modded tools ("x_pickaxe") count as wooden tier. */
export function bestToolIn (names: string[], kind: ToolKind): string | null {
  let best: string | null = null
  let rank = 0
  for (const n of names) {
    const r = toolTier(n, kind)
    if (r > rank) { rank = r; best = n }
  }
  return best
}

/** Planks a log, wood or stem turns into ("oak_log" -> "oak_planks"), or null. */
export function planksFor (log: string): string | null {
  if (log === 'bamboo_block' || log === 'stripped_bamboo_block') return 'bamboo_planks'
  const m = /^(?:stripped_)?([a-z_]+?)_(log|wood|stem|hyphae)$/.exec(log)
  return m ? `${m[1]}_planks` : null
}

const sum = (inv: Record<string, number>, re: RegExp) => Object.entries(inv).reduce((n, [k, v]) => n + (re.test(k) ? v : 0), 0)

/** Wood available in plank units: planks plus 4 per log. */
export function plankUnits (inv: Record<string, number>): number {
  return sum(inv, /_planks$/) + 4 * Object.entries(inv).reduce((n, [k, v]) => n + (planksFor(k) ? v : 0), 0)
}

/**
 * Tiers of a tool kind the inventory can make right now, best first. Sticks may still have to
 * be made from planks, planks from logs, and a crafting table from planks (`needTable`).
 */
export function craftableTiers (inv: Record<string, number>, kind: ToolKind, needTable = false): Tier[] {
  const shape = TOOL_SHAPE[kind]
  const sticks = inv.stick ?? 0
  const stickPlanks = sticks >= shape.sticks ? 0 : 2 * Math.ceil((shape.sticks - sticks) / 4)
  const wood = plankUnits(inv)
  const out: Tier[] = []
  for (const tier of TIERS) {
    if (tier === 'netherite') continue
    const head = HEAD[tier]
    const extra = stickPlanks + (needTable ? 4 : 0)
    if (tier === 'wooden') { if (wood >= shape.head + extra) out.push(tier); continue }
    if (sum(inv, head) >= shape.head && wood >= extra) out.push(tier)
  }
  return out
}

export function inventoryCounts (bot: Bot): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const i of bot.inventory.items()) inv[itemName(i)] = (inv[itemName(i)] ?? 0) + i.count
  return inv
}

function hasTableNear (bot: Bot): boolean {
  const id = bot.registry.blocksByName.crafting_table?.id
  return id !== undefined && !!bot.findBlock({ matching: id, maxDistance: 16 })
}

/**
 * Crafts planks from whatever logs the inventory has until it holds at least `want` planks.
 * A failed craft is retried once (the inventory can lag right after picking things up);
 * `onFail` hears about crafts that still fail.
 */
export async function ensurePlanks (bot: Bot, signal: AbortSignal, want: number, onFail?: (msg: string) => void): Promise<number> {
  let failures = 0
  for (let guard = 0; guard < 12 && failures < 2; guard++) {
    const have = sumPlanks(bot)
    if (have >= want) return have
    checkAborted(signal)
    const log = bot.inventory.items().map(itemName).find(n => planksFor(n) && bot.registry.itemsByName[planksFor(n)!])
    if (!log) return have
    const planks = planksFor(log)!
    const runs = Math.min(countItem(bot, log), Math.ceil((want - have) / 4))
    const r = await craftItem(bot, signal, planks, runs * 4).catch(e => fail((e as Error).message))
    if (!r.ok || sumPlanks(bot) <= have) {
      failures++
      onFail?.(r.message || `could not craft ${planks}`)
      await sleep(600, signal)
    }
  }
  return sumPlanks(bot)
}

function sumPlanks (bot: Bot): number {
  return bot.inventory.items().filter(i => /_planks$/.test(itemName(i))).reduce((n, i) => n + i.count, 0)
}

export async function ensureSticks (bot: Bot, signal: AbortSignal, want: number): Promise<boolean> {
  const have = countItem(bot, 'stick')
  if (have >= want) return true
  await ensurePlanks(bot, signal, 2 * Math.ceil((want - have) / 4))
  const r = await craftItem(bot, signal, 'stick', want - have)
  return r.ok && countItem(bot, 'stick') >= want
}

export interface EnsureToolOptions {
  /** Lowest acceptable tier (a stone pickaxe for iron ore). Default wooden. */
  minTier?: Tier
  /** Only craft when it costs nothing but crafting (never fail loudly, never place a table if none is near). */
  cheapOnly?: boolean
}

/**
 * Makes sure the inventory has a tool of `kind` (at least `minTier`), crafting the best one the
 * materials allow. Returns ok with the tool name (and whether it was crafted) or a fail that
 * says what is missing. Never gathers. `data` is { item, crafted } on success.
 */
export async function ensureTool (bot: Bot, signal: AbortSignal, kind: ToolKind, opts: EnsureToolOptions = {}): Promise<ActionResult> {
  const min = RANK[opts.minTier ?? 'wooden']!
  const names = bot.inventory.items().map(itemName)
  const have = bestToolIn(names, kind)
  if (have && toolTier(have, kind) >= min) return ok(`have ${have}`, { item: have, crafted: false })
  const needTable = !hasTableNear(bot) && !names.includes('crafting_table')
  const tiers = craftableTiers(inventoryCounts(bot), kind, needTable).filter(t => RANK[t]! >= min)
  if (opts.cheapOnly && needTable && tiers.length && plankUnits(inventoryCounts(bot)) < 4 + TOOL_SHAPE[kind].head + 2) return fail(`no ${kind}`)
  const tier = tiers[0]
  if (!tier) {
    const s = TOOL_SHAPE[kind]
    return fail(`no ${kind} and not enough materials to make one (a wooden ${kind} needs ${s.head} planks and ${s.sticks} sticks${needTable ? ', plus 4 planks for a crafting table' : ''})`)
  }
  checkAborted(signal)
  const shape = TOOL_SHAPE[kind]
  if (!await ensureSticks(bot, signal, shape.sticks)) return fail(`could not make sticks for a ${tier} ${kind}`)
  if (tier === 'wooden') await ensurePlanks(bot, signal, shape.head + (needTable ? 4 : 0))
  else if (needTable) await ensurePlanks(bot, signal, 4)
  const item = `${tier}_${kind}`
  const r = await craftItem(bot, signal, item, 1)
  if (!r.ok) return fail(`could not craft a ${item}: ${r.message}`)
  return ok(`crafted a ${item}`, { item, crafted: true })
}

/** Equips the best tool for breaking a block, if the inventory has one. */
export async function equipFor (bot: Bot, block: Block): Promise<void> {
  const tool = (bot.pathfinder as any)?.bestHarvestTool?.(block)
  if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
}

/** The tool kind a block wants, from its material ("mineable/pickaxe" -> pickaxe). */
export function toolKindFor (block: { material?: string | null, harvestTools?: Record<string, boolean> }): ToolKind | null {
  const m = block.material ?? ''
  if (m.includes('pickaxe')) return 'pickaxe'
  if (m.includes('axe')) return 'axe'
  if (m.includes('shovel')) return 'shovel'
  if (m.includes('hoe')) return 'hoe'
  return block.harvestTools ? 'pickaxe' : null
}

/** True when the block drops nothing without the right tool (stone, ores). */
export function needsTool (block: { harvestTools?: Record<string, boolean> }): boolean {
  return !!block.harvestTools && Object.keys(block.harvestTools).length > 0
}

/** Lowest tool tier that harvests a block (iron ore: stone), from its harvestTools item ids. */
export function minTierFor (registry: { items: Record<number, { name: string } | undefined> }, block: { harvestTools?: Record<string, boolean> }): Tier {
  let best = 99
  for (const id of Object.keys(block.harvestTools ?? {})) {
    const m = /^([a-z]+)_/.exec(registry.items[Number(id)]?.name ?? '')
    const r = m ? RANK[m[1]!] : undefined
    if (r !== undefined && r < best) best = r
  }
  return (TIERS.find(t => RANK[t] === best) ?? 'wooden')
}
