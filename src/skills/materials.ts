// gather_materials: one action for "get me what I need". It works out how many logs a list
// of wooden items takes (planks, sticks, doors, tables, tools...), chops trees until it has
// them (making an axe as soon as there is wood for one), crafts the intermediate steps and the
// items, and mines simple blocks (cobblestone, dirt, sand, gravel). The planning is pure
// (planWood) and unit tested; the rest reuses fellTree, collectBlocks and craftItem.
import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted } from '../core/index.ts'
import { fellTree } from './woodcutting.ts'
import { collectBlocks } from './gather.ts'
import { craftItem } from './crafting.ts'
import { ensurePlanks, ensureSticks, inventoryCounts, planksFor, bestToolIn, TOOL_SHAPE, type ToolKind } from './toolkit.ts'
import { materials, type ResolvedRole } from './blueprint.ts'
import { remainingWants } from './construction.ts'

/** Wooden things and what one craft costs / makes. `table`: needs a crafting table (3x3 grid). */
interface WoodRecipe { planks?: number, sticks?: number, coal?: number, out: number, table: boolean }

const TOOL_KINDS: ToolKind[] = ['axe', 'pickaxe', 'shovel', 'sword', 'hoe']

export function woodRecipe (item: string): WoodRecipe | null {
  if (item === 'stick') return { planks: 2, out: 4, table: false }
  if (item === 'crafting_table') return { planks: 4, out: 1, table: false }
  if (item === 'chest') return { planks: 8, out: 1, table: true }
  if (item === 'torch') return { sticks: 1, coal: 1, out: 4, table: false }
  if (item === 'ladder') return { sticks: 7, out: 3, table: true }
  if (item === 'iron_door' || item === 'iron_trapdoor') return null
  if (item === 'door' || /_door$/.test(item)) return { planks: 6, out: 3, table: true }
  if (item === 'trapdoor' || /_trapdoor$/.test(item)) return { planks: 6, out: 2, table: true }
  if (item === 'slab' || /^[a-z_]+_slab$/.test(item) && isWoodName(item.replace(/_slab$/, ''))) return { planks: 3, out: 6, table: true }
  if (item === 'stairs' || /^[a-z_]+_stairs$/.test(item) && isWoodName(item.replace(/_stairs$/, ''))) return { planks: 6, out: 4, table: true }
  if (item === 'fence' || /^[a-z_]+_fence$/.test(item) && isWoodName(item.replace(/_fence$/, ''))) return { planks: 4, sticks: 2, out: 3, table: true }
  for (const k of TOOL_KINDS) {
    if (item === `wooden_${k}`) return { planks: TOOL_SHAPE[k].head, sticks: TOOL_SHAPE[k].sticks, out: 1, table: true }
  }
  return null
}

const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'])
function isWoodName (w: string): boolean { return WOODS.has(w) }

/** Blocks to mine for simple non-wood materials (what drops it). */
export const MINE_SOURCES: Record<string, string[]> = {
  cobblestone: ['stone', 'cobblestone'],
  cobbled_deepslate: ['deepslate'],
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
  gravel: ['gravel'],
  stone: ['stone']
}

/** How many of a wanted item (or generic name: planks, log, door) an inventory holds. */
export function countWant (key: string, inv: Record<string, number>): number {
  const sum = (f: (k: string) => boolean) => Object.entries(inv).reduce((n, [k, v]) => n + (f(k) ? v : 0), 0)
  if (key === 'planks') return sum(k => /_planks$/.test(k))
  if (key === 'log' || key === 'logs') return sum(k => !!planksFor(k))
  if (key === 'door') return sum(k => /_door$/.test(k) && k !== 'iron_door')
  if (key === 'trapdoor') return sum(k => /_trapdoor$/.test(k) && k !== 'iron_trapdoor')
  if (key === 'slab' || key === 'stairs' || key === 'fence') return sum(k => k.endsWith(`_${key}`) && isWoodName(k.slice(0, -key.length - 1)))
  return inv[key] ?? 0
}

export interface WoodPlan {
  /** Logs still to chop. */
  logsToChop: number
  /** Planks to have once crafting starts: the ones asked for plus the ones crafts use up. */
  planks: number
  /** Sticks needed in total. */
  sticks: number
  needTable: boolean
  makeAxe: boolean
  /** Coal or charcoal missing for torches. */
  coalShort: number
  /** Simple blocks to mine: item -> count. */
  mine: Record<string, number>
  /** Wanted items nothing here can make. */
  unsupported: string[]
}

export interface PlanOptions {
  /** A crafting table is within reach (or in the inventory). */
  haveTable?: boolean
  /** Make a wooden axe first when at least this many logs must be chopped and there is no axe. Default 5. */
  axeAbove?: number
}

/** Works out logs, planks and sticks for a shopping list, given the inventory. Pure. */
export function planWood (wants: Record<string, number>, inv: Record<string, number>, opts: PlanOptions = {}): WoodPlan {
  let planks = 0 // planks to end up holding plus planks used up by crafts
  let logsKeep = 0
  let sticks = 0
  let coal = 0
  let table = false
  const mine: Record<string, number> = {}
  const unsupported: string[] = []
  for (const [item, want] of Object.entries(wants)) {
    const missing = Math.max(0, want - countWant(item, inv))
    if (item === 'planks' || /_planks$/.test(item)) { planks += want; continue }
    if (item === 'log' || item === 'logs' || planksFor(item)) { logsKeep += want; continue }
    if (!missing) continue
    if (item === 'stick') { sticks += missing; continue }
    if (MINE_SOURCES[item]) { mine[item] = missing; continue }
    const r = woodRecipe(item)
    if (!r) { unsupported.push(item); continue }
    const crafts = Math.ceil(missing / r.out)
    planks += (r.planks ?? 0) * crafts
    sticks += (r.sticks ?? 0) * crafts
    coal += (r.coal ?? 0) * crafts
    if (r.table) table = true
  }
  const haveAxe = !!bestToolIn(Object.keys(inv), 'axe')
  const draft = (extraPlanks: number, extraSticks: number, needTable: boolean) => {
    const stickCrafts = Math.ceil(Math.max(0, sticks + extraSticks - (inv.stick ?? 0)) / 4)
    const totalPlanks = planks + extraPlanks + 2 * stickCrafts + (needTable ? 4 : 0)
    const planksShort = Math.max(0, totalPlanks - countWant('planks', inv))
    return { totalPlanks, logs: Math.max(0, Math.ceil(planksShort / 4) + logsKeep - countWant('log', inv)) }
  }
  const needTable = table && !opts.haveTable && !inv.crafting_table
  let d = draft(0, 0, needTable)
  let makeAxe = false
  if (!haveAxe && d.logs >= (opts.axeAbove ?? 5)) {
    makeAxe = true
    d = draft(3, 2, !opts.haveTable && !inv.crafting_table)
  }
  return {
    logsToChop: d.logs,
    planks: d.totalPlanks,
    sticks: sticks + (makeAxe ? 2 : 0),
    needTable: makeAxe ? !opts.haveTable && !inv.crafting_table : needTable,
    makeAxe,
    coalShort: Math.max(0, coal - (inv.coal ?? 0) - (inv.charcoal ?? 0)),
    mine,
    unsupported
  }
}

/** The shopping-list key for a blueprint role: generic for "any wood" roles, the exact item otherwise. */
export function wantKeyFor (r: ResolvedRole): string {
  if (r.strict) return r.item
  if (r.accept.source.includes('_planks')) return 'planks'
  if (r.accept.source.includes('_door')) return 'door'
  if (r.accept.source.includes('_log')) return 'log'
  return r.item
}

/** Shopping list for blueprint cells still to place (required and optional parts). */
export function wantsForRoles (cells: { role: string }[], roles: Record<string, ResolvedRole>): { required: Record<string, number>, optional: Record<string, number> } {
  const required: Record<string, number> = {}
  const optional: Record<string, number> = {}
  for (const row of materials(cells, roles, {})) {
    const key = wantKeyFor(roles[row.role]!)
    const into = row.optional ? optional : required
    into[key] = (into[key] ?? 0) + row.need
  }
  return { required, optional }
}

export interface GatherOptions {
  radius?: number
  /** Items to try for but not fail on (torches without coal, glass). */
  optional?: Record<string, number>
  /** Most trees to fell in one go. Default 16. */
  maxTrees?: number
}

const fmtList = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ')

/**
 * Gathers and crafts a shopping list. Reports what it got and, truthfully, what is still
 * missing and why. ok only when every required item is there.
 */
export async function gatherMaterials (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, wants: Record<string, number>, opts: GatherOptions = {}): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  const all = { ...opts.optional, ...wants }
  const start = inventoryCounts(bot)
  const done = (inv: Record<string, number>) => Object.entries(wants).every(([k, n]) => countWant(k, inv) >= n)
  if (done(start) && Object.entries(opts.optional ?? {}).every(([k, n]) => countWant(k, start) >= n)) {
    return ok(`already have everything: ${fmtList(all)}`)
  }
  const tableId = bot.registry.blocksByName.crafting_table?.id
  const haveTable = () => tableId !== undefined && !!bot.findBlock({ matching: tableId, maxDistance: 16 })
  const notes: string[] = []

  // 1. wood: chop until the plan has enough logs
  let trees = 0
  let misses = 0
  let plan = planWood(all, inventoryCounts(bot), { haveTable: haveTable() })
  if (plan.logsToChop > 0 && !agent.canDig) return fail(`need ${plan.logsToChop} more logs but digging is disabled for this bot`)
  while (plan.logsToChop > 0 && trees < (opts.maxTrees ?? 16) && misses < 2) {
    checkAborted(signal)
    log.debug('gather: chopping', { logsToChop: plan.logsToChop, trees })
    const r = await fellTree(ctx, { radius: opts.radius ?? 32, replant: true, makeAxe: plan.makeAxe })
    if (r.ok) { trees++; misses = 0 } else { misses++; notes.push(r.message) }
    if (!r.ok && /no (natural )?tree|allowed to cut|disabled/.test(r.message)) break
    plan = planWood(all, inventoryCounts(bot), { haveTable: haveTable() })
  }

  // 2. intermediate crafting: planks, sticks
  checkAborted(signal)
  await ensurePlanks(bot, signal, plan.planks, msg => notes.push(`planks: ${msg}`))
  if (plan.sticks > 0) await ensureSticks(bot, signal, plan.sticks)

  // 3. the items themselves (wood products), then simple blocks
  for (const [item, want] of Object.entries(all)) {
    checkAborted(signal)
    const have = countWant(item, inventoryCounts(bot))
    if (have >= want) continue
    if (item === 'planks' || item === 'log' || item === 'logs' || item === 'stick' || /_planks$/.test(item) || planksFor(item)) {
      if (/_planks$/.test(item) && item !== 'planks') await craftItem(bot, signal, item, want - have).catch(() => fail(''))
      continue
    }
    if (MINE_SOURCES[item]) {
      for (const source of MINE_SOURCES[item]!) {
        const left = want - countWant(item, inventoryCounts(bot))
        if (left <= 0) break
        const r = await collectBlocks(ctx, source, Math.min(64, left))
        if (!r.ok) notes.push(r.message)
      }
      continue
    }
    if (item === 'torch' && !(inventoryCounts(bot).coal || inventoryCounts(bot).charcoal)) { notes.push('torches need coal or charcoal'); continue }
    const r = woodRecipe(item)
    if (!r) continue
    const name = concreteName(item, inventoryCounts(bot))
    if (!name) { notes.push(`no planks to make a ${item} from`); continue }
    const res = await craftItem(bot, signal, name, want - have).catch(e => fail((e as Error).message))
    if (!res.ok) notes.push(res.message)
  }

  // 4. report: required items first, optional extras separately, and why things are missing
  const inv = inventoryCounts(bot)
  const short = (m: Record<string, number>) => Object.entries(m).filter(([k, n]) => countWant(k, inv) < n).map(([k, n]) => `${n - countWant(k, inv)} ${k}`)
  const missingReq = short(wants)
  const missingOpt = short(opts.optional ?? {})
  const unsupported = planWood(wants, inv).unsupported.filter(k => countWant(k, inv) < (wants[k] ?? 0))
  const why = [...new Set(notes)].slice(0, 3).join('; ')
  const treeNote = trees ? `felled ${trees} tree${trees === 1 ? '' : 's'}, ` : ''
  const have = `have ${Object.keys(wants).map(k => `${countWant(k, inv)}/${wants[k]} ${k}`).join(', ')}`
  const optNote = missingOpt.length ? `; no ${missingOpt.join(', ')} (optional)` : ''
  const data = { have: Object.fromEntries(Object.keys(all).map(k => [k, countWant(k, inv)])), trees }
  if (!missingReq.length) return ok(`${treeNote}${have}${optNote}`, data)
  const cant = unsupported.length ? `; I can't make ${unsupported.join(', ')} myself` : ''
  return fail(`${treeNote}${have}; still missing ${missingReq.join(', ')}${cant}${why ? ` (${why})` : ''}${optNote}`, data)
}

/** A concrete item for a generic wood name ("door" -> "spruce_door" when spruce planks are what we have). */
function concreteName (item: string, inv: Record<string, number>): string | null {
  if (!['door', 'trapdoor', 'slab', 'stairs', 'fence'].includes(item)) return item
  const plank = Object.entries(inv).filter(([k]) => /_planks$/.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0]
  return plank ? `${plank.replace(/_planks$/, '')}_${item}` : null
}

const gatherAction = defineAction({
  name: 'gather_materials',
  description: 'Get the materials for a job in one go: chops as many trees as needed (crafting a wooden axe first), turns logs into planks and sticks, ' +
    'crafts wooden items (doors, crafting tables, chests, tools, torches if there is coal) and mines simple blocks (cobblestone, dirt, sand, gravel). ' +
    'Give either items, e.g. {"planks": 80, "door": 1} ("planks", "log", "door" mean any wood), or template="hut" for everything a blueprint needs. ' +
    'Prefer this over many chop_tree/craft calls. Needs digging enabled to chop or mine.',
  params: z.object({
    items: z.record(z.string(), z.number().int().min(1).max(512)).optional().describe('item -> count, e.g. {"oak_planks": 64, "stick": 8, "door": 1}'),
    template: z.string().optional().describe('blueprint name (see build_plan) to gather everything it needs'),
    material: z.string().optional().describe('with template: the main block to use, e.g. spruce_planks or cobblestone'),
    radius: z.number().int().min(8).max(64).default(32).describe('how far to look for trees and blocks')
  }),
  longRunning: true,
  async run (ctx, { items, template, material, radius }) {
    let wants: Record<string, number> = { ...items }
    let optional: Record<string, number> = {}
    let note = ''
    if (template) {
      // Only what is still missing at the site (a half-built hut needs less).
      const w = remainingWants(ctx, template, material)
      if (typeof w === 'string') return fail(w)
      wants = { ...w.required, ...wants }
      optional = w.optional
      note = w.note
    }
    if (!Object.keys(wants).length && !Object.keys(optional).length) return template ? ok(`nothing to gather: ${note || `the ${template} is complete`}`) : fail('nothing to gather: give items or a template')
    const r = await gatherMaterials(ctx, wants, { radius, optional })
    return note ? { ...r, message: `${r.message} (${note})` } : r
  }
})

export const materialsSkill = () => defineSkill({
  name: 'materials',
  description: 'Gathering and crafting everything a job needs.',
  actions: [gatherAction]
})
