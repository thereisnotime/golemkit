// Tool prerequisites: make sure the bot holds a usable axe/pickaxe/shovel/sword before work
// that needs one, crafting the best tier the inventory allows (planks from logs, sticks from
// planks, a crafting table when the recipe needs it). It never goes out to gather; callers
// that can gather (gather_materials) do that first.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { checkAborted, itemName, ok, fail, sleep, type ActionResult } from '../core/index.ts'
import { craftItem } from './crafting.ts'
import { countItem } from './world.ts'
import { TIER_RANK } from './tiers.ts'

export type ToolKind = 'axe' | 'pickaxe' | 'shovel' | 'sword' | 'hoe'
export type Tier = 'wooden' | 'stone' | 'iron' | 'diamond' | 'netherite'

/** Best first. Golden tools are left out on purpose (they break almost at once). */
export const TIERS: Tier[] = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
const RANK = TIER_RANK

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
 * Wood usable for crafting, in plank units. A recipe takes planks of one kind (two oak, not one
 * oak and one spruce), so a lone plank of a kind that no log in the inventory turns into counts
 * for nothing: 1 oak + 1 spruce planks and no logs can't make sticks.
 */
export function usablePlankUnits (inv: Record<string, number>): number {
  const fromLogs = new Set<string>()
  let logs = 0
  for (const [k, v] of Object.entries(inv)) {
    const p = planksFor(k)
    if (p && v > 0) { logs += v; fromLogs.add(p) }
  }
  let planks = 0
  for (const [k, v] of Object.entries(inv)) if (/_planks$/.test(k) && v > 0 && (v >= 2 || fromLogs.has(k))) planks += v
  return planks + 4 * logs
}

/** Most planks of one kind in the inventory. */
export function samePlanks (inv: Record<string, number>): { item: string | null, count: number } {
  let best: { item: string | null, count: number } = { item: null, count: 0 }
  for (const [k, v] of Object.entries(inv)) if (/_planks$/.test(k) && v > best.count) best = { item: k, count: v }
  return best
}

/**
 * Which log to turn into planks (and how many crafts) so that one kind of planks reaches
 * `want`: 'enough' when a kind already has that many, null when no log can get there. Prefers
 * the kind with the most planks already, then the most logs. `known` filters plank names the
 * game has (modded logs whose planks have another name are skipped). Pure.
 */
export function plankTopUp (inv: Record<string, number>, want: number, known: (planks: string) => boolean = () => true): 'enough' | { log: string, planks: string, runs: number } | null {
  if (samePlanks(inv).count >= want) return 'enough'
  let best: { log: string, planks: string, runs: number, score: number } | null = null
  for (const [k, v] of Object.entries(inv)) {
    const p = planksFor(k)
    if (!p || v <= 0 || !known(p)) continue
    const have = inv[p] ?? 0
    const runs = Math.min(v, Math.ceil((want - have) / 4))
    if (have + 4 * runs < want) continue
    const score = have * 1000 + v
    if (!best || score > best.score) best = { log: k, planks: p, runs, score }
  }
  // none can reach `want` alone: the kind that gets closest
  if (!best) {
    for (const [k, v] of Object.entries(inv)) {
      const p = planksFor(k)
      if (!p || v <= 0 || !known(p)) continue
      const reach = (inv[p] ?? 0) + 4 * v
      if (!best || reach > best.score) best = { log: k, planks: p, runs: v, score: reach }
    }
  }
  return best ? { log: best.log, planks: best.planks, runs: best.runs } : null
}

/** "1 oak_planks, 1 spruce_planks, no logs" for failure messages. */
export function woodSummary (inv: Record<string, number>): string {
  const planks = Object.entries(inv).filter(([k, v]) => /_planks$/.test(k) && v > 0).map(([k, v]) => `${v} ${k}`)
  const logs = Object.entries(inv).filter(([k, v]) => planksFor(k) && v > 0).map(([k, v]) => `${v} ${k}`)
  const sticks = inv.stick ? [`${inv.stick} stick`] : []
  return [...sticks, ...(planks.length ? planks : ['no planks']), ...(logs.length ? logs : ['no logs'])].join(', ')
}

/**
 * Tiers of a tool kind the inventory can make right now, best first. Sticks may still have to
 * be made from planks, planks from logs, and a crafting table from planks (`needTable`).
 */
export function craftableTiers (inv: Record<string, number>, kind: ToolKind, needTable = false): Tier[] {
  const shape = TOOL_SHAPE[kind]
  const sticks = inv.stick ?? 0
  const stickPlanks = sticks >= shape.sticks ? 0 : 2 * Math.ceil((shape.sticks - sticks) / 4)
  const wood = usablePlankUnits(inv)
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

/**
 * Whether a worn tool ("stone_sword") can be made again from what it carries: the head material
 * (any of the stone variants for stone) and its sticks, or planks for them. Pure. A craft that
 * can't work only fails and backs keep_tools_upgraded off (Pax kept trying a stone sword with no
 * cobblestone, "need 2 cobbled_deepslate", while its upgrades waited).
 */
export function remakeable (inv: Record<string, number>, name: string): { ok: true, sticks: number } | { ok: false, why: string } {
  const m = /^([a-z]+)_(axe|pickaxe|shovel|sword|hoe)$/.exec(name)
  if (!m || !(m[1]! in HEAD)) return { ok: false, why: `${name} is not a tool it makes` }
  const tier = m[1] as Exclude<Tier, 'netherite'>
  const kind = m[2] as ToolKind
  if (!craftableTiers(inv, kind).includes(tier)) return { ok: false, why: `not enough to make a ${name}` }
  return { ok: true, sticks: Math.max(0, TOOL_SHAPE[kind].sticks - (inv.stick ?? 0)) }
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

/**
 * Like ensurePlanks, but for one recipe: crafts planks until a single kind has `want` (a stick
 * or a tool takes planks of one kind; 1 oak + 1 spruce plank make nothing). Returns the most
 * planks of one kind it ends up with.
 */
export async function ensureSamePlanks (bot: Bot, signal: AbortSignal, want: number): Promise<number> {
  for (let guard = 0; guard < 6; guard++) {
    checkAborted(signal)
    const inv = inventoryCounts(bot)
    const plan = plankTopUp(inv, want, p => !!bot.registry.itemsByName[p])
    if (plan === 'enough' || !plan) break
    const before = inv[plan.planks] ?? 0
    const r = await craftItem(bot, signal, plan.planks, plan.runs * 4).catch(e => fail((e as Error).message))
    if (!r.ok || countItem(bot, plan.planks) <= before) break
  }
  return samePlanks(inventoryCounts(bot)).count
}

export async function ensureSticks (bot: Bot, signal: AbortSignal, want: number): Promise<boolean> {
  const have = countItem(bot, 'stick')
  if (have >= want) return true
  await ensureSamePlanks(bot, signal, 2 * Math.ceil((want - have) / 4))
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
  if (opts.cheapOnly && needTable && tiers.length && usablePlankUnits(inventoryCounts(bot)) < 4 + TOOL_SHAPE[kind].head + 2) return fail(`no ${kind}`)
  const tier = tiers[0]
  if (!tier) {
    const s = TOOL_SHAPE[kind]
    return fail(`no ${kind} and not enough materials to make one (a wooden ${kind} needs ${s.head} planks and ${s.sticks} sticks${needTable ? ', plus 4 planks for a crafting table' : ''})`)
  }
  checkAborted(signal)
  const shape = TOOL_SHAPE[kind]
  if (!await ensureSticks(bot, signal, shape.sticks)) return fail(`could not make sticks for a ${tier} ${kind} (have ${woodSummary(inventoryCounts(bot))})`, { need: 'wood' })
  // the table is crafted first (inside craftItem), so a wooden tool wants head + 4 of one kind
  if (tier === 'wooden') await ensureSamePlanks(bot, signal, shape.head + (needTable ? 4 : 0))
  else if (needTable) await ensureSamePlanks(bot, signal, 4)
  const item = `${tier}_${kind}`
  const r = await craftItem(bot, signal, item, 1)
  if (!r.ok) return fail(`could not craft a ${item}: ${r.message}`)
  return ok(`crafted a ${item}`, { item, crafted: true })
}

/** Equips the best tool for breaking a block, if the inventory has one. */
export async function equipFor (bot: Bot, block: Block): Promise<void> {
  // By name first: on modded servers the registry sync renumbers items, so the pathfinder's
  // id-based bestHarvestTool can come back empty and the bot mines stone with a block in hand.
  const kind = toolKindFor(block as any)
  if (kind) {
    const items = bot.inventory.items()
    const name = bestToolIn(items.map(i => itemName(i)), kind)
    const tool = name ? items.find(i => itemName(i) === name) : undefined
    if (tool) {
      if ((bot.heldItem ? itemName(bot.heldItem) : '') !== name) await bot.equip(tool, 'hand').catch(() => {})
      return
    }
  }
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

/** Why digging this block would give nothing with what's in hand, or null if it's fine. */
export function harvestProblem (bot: Bot, block: Block): string | null {
  if (!needsTool(block as any)) return null
  const kind = toolKindFor(block as any) ?? 'pickaxe'
  const held = bot.heldItem ? itemName(bot.heldItem) : ''
  if (toolTier(held, kind) > 0) return null
  return `${block.name} drops nothing without a ${kind} (holding ${held || 'nothing'})`
}

/**
 * Notices digging that yields nothing: every `window` dug source blocks it checks that the
 * inventory grew. If it didn't, it says why (wrong tool in hand, inventory full, drops left lying
 * around), so collectors stop and report instead of mining for nothing.
 */
export function dropWatch (bot: Bot, window = 5): { dug: (block?: Block) => string | null, recheck: () => boolean } {
  const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0)
  let base = total()
  let n = 0
  let lastBlock: Block | undefined
  let checkFrom = base
  return {
    /** After sweeping up drops: did the inventory grow since the failed check? Resets the window if so. */
    recheck () {
      const now = total()
      if (now > checkFrom) { base = now; n = 0; return true }
      return false
    },
    dug (block?: Block) {
      if (block) lastBlock = block
      if (++n < window) return null
      const now = total()
      const gained = now > base
      checkFrom = now
      base = now
      n = 0
      if (gained) return null
      const free = bot.inventory.slots.slice(9, 45).filter(s => !s).length
      const lying = Object.values(bot.entities).filter(e => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 8).length
      const tool = lastBlock ? harvestProblem(bot, lastBlock) : null
      const why = tool ?? (free === 0 ? 'my inventory is full' : lying ? `${lying} drops are lying around that I didn't pick up` : 'no idea why (maybe the server ate them, or they fell somewhere I can\'t reach)')
      return `dug ${window} blocks in a row and got nothing: ${why}`
    }
  }
}
