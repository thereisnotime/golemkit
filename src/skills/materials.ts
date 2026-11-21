// gather_materials: one action for "get me what I need". It works out how many logs a list
// of items takes (planks, sticks, stairs, slabs, fences, doors, trapdoors, ladders, tables,
// chests, beds, tools...), chops trees until it has them (making an axe as soon as there is
// wood for one), crafts the intermediate steps and the items, mines simple blocks (cobblestone
// with a pickaxe, andesite, diorite, granite, tuff, dirt, sand, gravel), and goes the extra mile
// for the nice-to-haves: coal or charcoal for torches, glass from sand, wool from sheep for a
// bed. Stone-family blocks (slabs, stairs, walls, stone bricks, smooth stone) come from
// cobblestone, smelted when needed. Optional things that can't be had are skipped and reported. The planning is pure (planWood) and unit tested; the rest
// reuses fellTree, collectBlocks, craftItem, smeltItem and fight.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, sleep, itemName, goals } from '../core/index.ts'
import { fellTree } from './woodcutting.ts'
import { collectBlocks } from './gather.ts'
import { craftItem, smeltItem } from './crafting.ts'
import { fight, huntRefusal, inPen, type HuntCandidate } from './combat.ts'
import { pickupNearby } from './pickup.ts'
import { digBlock, gotoWithin } from './world.ts'
import { ensurePlanks, ensureSticks, ensureTool, inventoryCounts, planksFor, bestToolIn, TOOL_SHAPE, type ToolKind } from './toolkit.ts'
import { materials, pickTheme, WOODS, type ResolvedRole } from './blueprint.ts'
import { remainingWants } from './construction.ts'
import { autoUpgrade, gatherStone, pickBuildMaterial } from './progression.ts'
import { makeRoom } from './efficiency.ts'
import { isCreative, takeFromCreative } from './creative.ts'

/**
 * What one craft costs and makes. `table`: needs a crafting table (3x3 grid). Non-wood inputs:
 * coal (or charcoal), cobblestone, wool, glass.
 */
interface Recipe { planks?: number, sticks?: number, coal?: number, cobble?: number, wool?: number, glass?: number, stone?: number, bricks?: number, smooth?: number, out: number, table: boolean }

const TOOL_KINDS: ToolKind[] = ['axe', 'pickaxe', 'shovel', 'sword', 'hoe']

/** The recipe for an item or a generic wood name (door, stairs...), or null when we can't make it. */
export function woodRecipe (item: string): Recipe | null {
  if (item === 'stick') return { planks: 2, out: 4, table: false }
  if (item === 'crafting_table') return { planks: 4, out: 1, table: false }
  if (item === 'chest') return { planks: 8, out: 1, table: true }
  if (item === 'torch') return { sticks: 1, coal: 1, out: 4, table: false }
  if (item === 'ladder') return { sticks: 7, out: 3, table: true }
  if (item === 'furnace') return { cobble: 8, out: 1, table: true }
  if (item === 'glass_pane') return { glass: 6, out: 16, table: true }
  if (item === 'bed' || (/_bed$/.test(item) && isColor(item.replace(/_bed$/, '')))) return { planks: 3, wool: 3, out: 1, table: true }
  if (item === 'carpet' || (/_carpet$/.test(item) && isColor(item.replace(/_carpet$/, '')))) return { wool: 2, out: 3, table: false }
  if (item === 'iron_door' || item === 'iron_trapdoor') return null
  if (item === 'trapdoor' || /_trapdoor$/.test(item)) return { planks: 6, out: 2, table: true }
  if (item === 'door' || /_door$/.test(item)) return { planks: 6, out: 3, table: true }
  if (item === 'slab' || /^[a-z_]+_slab$/.test(item) && isWoodName(item.replace(/_slab$/, ''))) return { planks: 3, out: 6, table: true }
  if (item === 'stairs' || /^[a-z_]+_stairs$/.test(item) && isWoodName(item.replace(/_stairs$/, ''))) return { planks: 6, out: 4, table: true }
  if (item === 'fence' || /^[a-z_]+_fence$/.test(item) && isWoodName(item.replace(/_fence$/, ''))) return { planks: 4, sticks: 2, out: 3, table: true }
  if (item === 'fence_gate' || /^[a-z_]+_fence_gate$/.test(item) && isWoodName(item.replace(/_fence_gate$/, ''))) return { planks: 2, sticks: 4, out: 1, table: true }
  for (const k of TOOL_KINDS) {
    if (item === `wooden_${k}`) return { planks: TOOL_SHAPE[k].head, sticks: TOOL_SHAPE[k].sticks, out: 1, table: true }
  }
  return null
}

/**
 * Stone-family crafts (vanilla crafting table recipes): cobblestone, stone, stone brick and
 * smooth stone slabs, stairs and walls, stone bricks, buttons and pressure plates. Inputs:
 * cobble (cobblestone), stone (smelted cobblestone), bricks (stone_bricks), smooth (smooth_stone).
 */
export function stoneRecipe (item: string): Recipe | null {
  if (item === 'stone_bricks') return { stone: 4, out: 4, table: false }
  if (item === 'stone_button') return { stone: 1, out: 1, table: false }
  if (item === 'stone_pressure_plate') return { stone: 2, out: 1, table: false }
  const m = /^(cobblestone|stone|stone_brick|smooth_stone)_(slab|stairs|wall)$/.exec(item)
  if (!m) return null
  const inputs: Record<string, 'cobble' | 'stone' | 'bricks' | 'smooth'> = { cobblestone: 'cobble', stone: 'stone', stone_brick: 'bricks', smooth_stone: 'smooth' }
  const input = inputs[m[1]!]!
  const shape = m[2]!
  if (shape === 'wall' && (input === 'stone' || input === 'smooth')) return null // no such block
  if (shape === 'stairs' && input === 'smooth') return null
  const n = shape === 'slab' ? 3 : 6
  return { [input]: n, out: shape === 'stairs' ? 4 : 6, table: true }
}

/** What each smelted stone block is smelted from, in the order they have to be made. */
export const STONE_SMELTS: [string, string][] = [['stone', 'cobblestone'], ['smooth_stone', 'stone'], ['cracked_stone_bricks', 'stone_bricks']]

export interface StoneChain {
  /** Cobblestone to have in total for the stone family (crafts plus smelting), before what's held. */
  cobble: number
  /** Items still to smelt, in order: stone (from cobblestone), smooth_stone (from stone), cracked_stone_bricks. */
  smelt: Record<string, number>
  /** stone_bricks crafts (4 stone -> 4 bricks) still to do. */
  brickCrafts: number
}

/**
 * The stone family part of a shopping list (pure): how much stone, smooth stone and stone
 * bricks the wanted items take, what has to be smelted or crafted for them given the
 * inventory, and how much cobblestone that comes down to. Mining only ever gives cobblestone.
 */
export function stoneChain (wants: Record<string, number>, inv: Record<string, number>): StoneChain {
  const need = { cobble: 0, stone: 0, bricks: 0, smooth: 0, cracked: 0 }
  for (const [item, want] of Object.entries(wants)) {
    if (item === 'stone') need.stone += want
    else if (item === 'smooth_stone') need.smooth += want
    else if (item === 'stone_bricks') need.bricks += want
    else if (item === 'cracked_stone_bricks') need.cracked += want
    else {
      const r = stoneRecipe(item)
      if (!r) continue
      const crafts = Math.ceil(Math.max(0, want - (inv[item] ?? 0)) / r.out)
      need.cobble += (r.cobble ?? 0) * crafts
      need.stone += (r.stone ?? 0) * crafts
      need.bricks += (r.bricks ?? 0) * crafts
      need.smooth += (r.smooth ?? 0) * crafts
    }
  }
  const cracked = Math.max(0, need.cracked - (inv.cracked_stone_bricks ?? 0))
  need.bricks += cracked
  const bricksShort = Math.max(0, need.bricks - (inv.stone_bricks ?? 0))
  const brickCrafts = Math.ceil(bricksShort / 4)
  const smooth = Math.max(0, need.smooth - (inv.smooth_stone ?? 0))
  need.stone += smooth + brickCrafts * 4
  const stone = Math.max(0, need.stone - (inv.stone ?? 0))
  const smelt: Record<string, number> = {}
  if (stone) smelt.stone = stone
  if (smooth) smelt.smooth_stone = smooth
  if (cracked) smelt.cracked_stone_bricks = cracked
  return { cobble: need.cobble + stone, smelt, brickCrafts }
}

const STONE_INTERMEDIATE = new Set(['stone', 'smooth_stone', 'stone_bricks', 'cracked_stone_bricks'])

const WOOD_SET = new Set<string>([...WOODS, 'bamboo', 'crimson', 'warped'])
function isWoodName (w: string): boolean { return WOOD_SET.has(w) }
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
function isColor (c: string): boolean { return COLORS.includes(c) }

/** Blocks to mine for simple non-wood materials (what drops it). */
export const MINE_SOURCES: Record<string, string[]> = {
  cobblestone: ['stone', 'cobblestone'],
  cobbled_deepslate: ['deepslate'],
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
  gravel: ['gravel'],
  andesite: ['andesite'],
  diorite: ['diorite'],
  granite: ['granite'],
  tuff: ['tuff']
}

/** Mined blocks that need a pickaxe. */
const NEEDS_PICKAXE = new Set(['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff'])

/** Generic names that mean "any wood" (or any colour, for beds and carpets). */
const GENERIC = ['planks', 'log', 'logs', 'door', 'trapdoor', 'slab', 'stairs', 'fence', 'fence_gate', 'bed', 'carpet']

/** How many of a wanted item (or generic name: planks, log, door, stairs, bed...) an inventory holds. */
export function countWant (key: string, inv: Record<string, number>): number {
  const sum = (f: (k: string) => boolean) => Object.entries(inv).reduce((n, [k, v]) => n + (f(k) ? v : 0), 0)
  if (key === 'planks') return sum(k => /_planks$/.test(k))
  if (key === 'log' || key === 'logs') return sum(k => !!planksFor(k))
  if (key === 'door') return sum(k => /_door$/.test(k) && k !== 'iron_door')
  if (key === 'trapdoor') return sum(k => /_trapdoor$/.test(k) && k !== 'iron_trapdoor')
  if (key === 'slab' || key === 'stairs' || key === 'fence' || key === 'fence_gate') return sum(k => k.endsWith(`_${key}`) && isWoodName(k.slice(0, -key.length - 1)))
  if (key === 'bed' || key === 'carpet') return sum(k => k.endsWith(`_${key}`) && isColor(k.slice(0, -key.length - 1)))
  if (key === 'glass_pane') return inv.glass_pane ?? 0
  if (key === 'coal') return (inv.coal ?? 0) + (inv.charcoal ?? 0)
  return inv[key] ?? 0
}

export interface WoodPlan {
  /** Logs still to chop (for planks, for blocks that are logs, and charcoal). */
  logsToChop: number
  /** Planks to have once crafting starts: the ones asked for plus the ones crafts and fuel use up. */
  planks: number
  /** Sticks needed in total. */
  sticks: number
  needTable: boolean
  makeAxe: boolean
  /** A pickaxe has to be made for mining cobblestone. */
  makePickaxe: boolean
  /** Coal or charcoal missing for torches. */
  coalShort: number
  /** Simple blocks to mine: item -> count (cobblestone for a furnace recipe included). */
  mine: Record<string, number>
  /** Wool for beds and carpets. */
  wool: number
  /** Glass still to smelt from sand (for panes). */
  glass: number
  /** Logs to smelt into charcoal when there is no coal. */
  charcoal: number
  /** Something must be smelted and there's no furnace: 8 more cobblestone unless a furnace is wanted anyway. */
  needFurnace: boolean
  furnaceCobble: number
  /** Planks burnt as fuel. */
  fuelPlanks: number
  /** Stone-family smelting still to do (stone, smooth_stone, cracked_stone_bricks), in order. */
  stoneSmelt: Record<string, number>
  /** stone_bricks crafts still to do. */
  brickCrafts: number
  /** Wanted items nothing here can make. */
  unsupported: string[]
}

export interface PlanOptions {
  /** A crafting table is within reach (or in the inventory). */
  haveTable?: boolean
  /** A furnace is within reach. */
  haveFurnace?: boolean
  /** Make a wooden axe first when at least this many logs must be chopped and there is no axe. Default 5. */
  axeAbove?: number
}

/** Works out logs, planks, sticks, mining and smelting for a shopping list, given the inventory. Pure. */
export function planWood (wants: Record<string, number>, inv: Record<string, number>, opts: PlanOptions = {}): WoodPlan {
  let planks = 0 // planks to end up holding plus planks used up by crafts
  let logsKeep = 0
  let sticks = 0
  let coal = 0
  let cobble = 0
  let wool = 0
  let glass = 0
  let table = false
  const mine: Record<string, number> = {}
  const unsupported: string[] = []
  // intermediate products first, so glass for panes is counted once
  const order = Object.entries(wants).sort(([a], [b]) => Number(b === 'glass_pane') - Number(a === 'glass_pane'))
  for (const [item, want] of order) {
    const missing = Math.max(0, want - countWant(item, inv))
    if (item === 'planks' || /_planks$/.test(item)) { planks += want; continue }
    if (item === 'log' || item === 'logs' || planksFor(item)) { logsKeep += want; continue }
    if (!missing) continue
    if (item === 'stick') { sticks += missing; continue }
    if (item === 'glass') { glass += missing; continue }
    if (item === 'coal' || item === 'charcoal') { coal += missing; continue }
    if (MINE_SOURCES[item]) { mine[item] = (mine[item] ?? 0) + missing; continue }
    if (STONE_INTERMEDIATE.has(item) || stoneRecipe(item)) continue // stoneChain below
    const r = woodRecipe(item)
    if (!r) { unsupported.push(item); continue }
    const crafts = Math.ceil(missing / r.out)
    planks += (r.planks ?? 0) * crafts
    sticks += (r.sticks ?? 0) * crafts
    coal += (r.coal ?? 0) * crafts
    cobble += (r.cobble ?? 0) * crafts
    wool += (r.wool ?? 0) * crafts
    glass += (r.glass ?? 0) * crafts
    if (r.table) table = true
  }
  glass = Math.max(0, glass - (inv.glass ?? 0))
  const chain = stoneChain(wants, inv)
  cobble += chain.cobble
  if (Object.entries(wants).some(([k, n]) => stoneRecipe(k)?.table && countWant(k, inv) < n)) table = true
  if (cobble) mine.cobblestone = Math.max(0, (mine.cobblestone ?? 0) + cobble - (wants.cobblestone ? 0 : countWant('cobblestone', inv)))
  if (mine.cobblestone === 0) delete mine.cobblestone
  const coalShort = Math.max(0, coal - countWant('coal', inv))
  const charcoal = coalShort
  const stoneSmelts = Object.values(chain.smelt).reduce((a, b) => a + b, 0)
  const smelts = glass + charcoal + stoneSmelts
  const haveFurnace = !!opts.haveFurnace || (inv.furnace ?? 0) > 0
  const needFurnace = smelts > 0 && !haveFurnace
  // the furnace used for smelting is picked up again afterwards, so a wanted furnace costs nothing extra
  const furnaceCobble = needFurnace && !wants.furnace ? 8 : 0
  const fuelPlanks = smelts ? Math.ceil(smelts / 1.5) : 0
  planks += fuelPlanks
  logsKeep += charcoal
  const makePickaxe = (Object.keys(mine).some(k => NEEDS_PICKAXE.has(k) && mine[k]! > 0) || furnaceCobble > 0) && !bestToolIn(Object.keys(inv), 'pickaxe')
  if (makePickaxe) { planks += TOOL_SHAPE.pickaxe.head; sticks += TOOL_SHAPE.pickaxe.sticks; table = true }

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
    makePickaxe,
    coalShort,
    mine,
    wool: Math.max(0, wool - Object.entries(inv).reduce((n, [k, v]) => n + (/_wool$/.test(k) ? v : 0), 0)),
    glass,
    charcoal,
    needFurnace,
    furnaceCobble,
    fuelPlanks,
    stoneSmelt: chain.smelt,
    brickCrafts: chain.brickCrafts,
    unsupported
  }
}

/** The shopping-list key for a blueprint role: generic for "any wood" roles, the exact item otherwise. */
export function wantKeyFor (r: ResolvedRole): string {
  if (r.strict) return r.item
  const src = r.accept.source
  if (src.includes('_planks')) return 'planks'
  if (src.includes('_trapdoor')) return 'trapdoor'
  if (src.includes('_door')) return 'door'
  if (src.includes('_stairs')) return 'stairs'
  if (src.includes('_slab')) return 'slab'
  if (src.includes('_fence_gate')) return 'fence_gate'
  if (src.includes('_fence')) return 'fence'
  if (src.includes('_bed')) return 'bed'
  if (src.includes('_carpet')) return 'carpet'
  if (src.includes('_log')) return 'log'
  if (src.includes('torch')) return 'torch'
  return r.item
}

/** Generic fallback key of an item ("oak_fence" -> "fence"). */
function fallbackKey (item: string): string {
  const m = /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(fence_gate|fence|trapdoor|door|slab|stairs|planks)$/.exec(item)
  return m ? m[1]! : item
}

export interface RoleWants {
  required: Record<string, number>
  optional: Record<string, number>
  /** For optional items that may be unobtainable: what to get instead ({ glass_pane: { fence: 7 } }). */
  fallbacks: Record<string, Record<string, number>>
}

/** Shopping list for blueprint cells still to place (required and optional parts, and fallbacks). */
export function wantsForRoles (cells: { role: string, passive?: boolean }[], roles: Record<string, ResolvedRole>): RoleWants {
  const required: Record<string, number> = {}
  const optional: Record<string, number> = {}
  const fallbacks: Record<string, Record<string, number>> = {}
  for (const row of materials(cells, roles, {})) {
    const r = roles[row.role]!
    if (r.gather === false) continue
    const key = wantKeyFor(r)
    const into = row.optional ? optional : required
    into[key] = (into[key] ?? 0) + row.need
    const fb = r.fallbacks?.[0]
    if (fb) {
      const f = (fallbacks[key] ??= {})
      f[fallbackKey(fb.item)] = (f[fallbackKey(fb.item)] ?? 0) + row.need
    }
  }
  return { required, optional, fallbacks }
}

export interface GatherOptions {
  radius?: number
  /** Items to try for but not fail on (torches without coal, glass, a bed). */
  optional?: Record<string, number>
  /** What to get instead of optional items that turned out unobtainable. */
  fallbacks?: Record<string, Record<string, number>>
  /** Most trees to fell in one go. Default: enough for the plan, 16 to 40. */
  maxTrees?: number
  /** Wood to prefer for crafted items (oak, spruce...). */
  theme?: string
}

const fmtList = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ')

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

/** Most time spent fetching one optional extra (stone for a furnace, coal ore, sand). */
const EXTRA_MS = 3 * 60_000

/**
 * Runs a step with its own time limit: the step sees a signal that aborts after `ms` (or when
 * the action is stopped). Running out of time is a plain failure, stopping the action still throws.
 */
async function withBudget (ctx: Ctx, ms: number, fn: (c: Ctx) => Promise<ActionResult>): Promise<ActionResult> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fn({ ...ctx, signal: ctl.signal })
  } catch (e) {
    checkAborted(ctx.signal)
    if (ctl.signal.aborted) return fail(`gave up after ${Math.round(ms / 60_000)} min`)
    throw e
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
    ctx.bot.pathfinder?.setGoal(null)
  }
}

/** A block of a type within radius with open air above it (no tunnelling for optional extras). */
function findExposed (bot: Bot, name: string, radius: number): boolean {
  const type = bot.registry.blocksByName[name]
  if (!type) return false
  return bot.findBlocks({ matching: type.id, maxDistance: radius, count: 64 }).some(p => {
    const above = bot.blockAt(p.offset(0, 1, 0))
    return !!above && (above.name === 'air' || above.name === 'short_grass' || above.name === 'snow')
  })
}

/** A furnace in the inventory, crafted from cobblestone, or false. Mines 8 cobblestone only when stone is exposed nearby. */
async function ensureFurnace (ctx: Ctx, radius: number, notes: string[]): Promise<boolean> {
  const { bot, signal } = ctx
  const furnaceId = bot.registry.blocksByName.furnace?.id
  if (furnaceId !== undefined && bot.findBlock({ matching: furnaceId, maxDistance: 32 })) return true
  if (countWant('furnace', inventoryCounts(bot))) return true
  const cobble = () => countWant('cobblestone', inventoryCounts(bot))
  if (cobble() < 8) {
    if (!ctx.agent.canDig || !(findExposed(bot, 'stone', radius) || findExposed(bot, 'cobblestone', radius))) { notes.push('no furnace and no stone in sight for one'); return false }
    const r = await withBudget(ctx, EXTRA_MS, c => collectBlocks(c, 'stone', 8 - cobble()))
    if (!r.ok) { notes.push(`furnace: ${r.message}`); return false }
  }
  checkAborted(signal)
  const r = await craftItem(bot, signal, 'furnace', 1).catch(e => fail((e as Error).message))
  if (!r.ok) notes.push(`furnace: ${r.message}`)
  return r.ok
}

/** Coal from exposed coal ore, else charcoal from logs in a furnace. Returns coal + charcoal held. */
async function ensureCoal (ctx: Ctx, need: number, radius: number, notes: string[], placedFurnaces: { x: number, y: number, z: number }[]): Promise<number> {
  const { bot, signal, log } = ctx
  const have = () => countWant('coal', inventoryCounts(bot))
  if (have() >= need) return have()
  if (ctx.agent.canDig && findExposed(bot, 'coal_ore', radius)) {
    const r = await withBudget(ctx, EXTRA_MS, c => collectBlocks(c, 'coal_ore', need - have()))
    if (!r.ok) notes.push(`coal: ${r.message}`)
  }
  if (have() >= need) return have()
  checkAborted(signal)
  const log0 = Object.keys(inventoryCounts(bot)).find(k => /_(log|stem)$/.test(k) && planksFor(k))
  if (!log0) { notes.push('no coal and no spare log for charcoal'); return have() }
  if (!await ensureFurnace(ctx, radius, notes)) { log.debug('gather: no furnace for charcoal', { notes: notes.join('; ') }); return have() }
  const r = await smeltItem(bot, signal, log, log0, need - have(), plankFuel(bot))
  log.debug('gather: charcoal', { ok: r.ok, result: r.message })
  const placed = (r.data as { placed?: { x: number, y: number, z: number } } | undefined)?.placed
  if (placed) placedFurnaces.push(placed)
  if (!r.ok) notes.push(`charcoal: ${r.message}`)
  return have()
}

/** Planks to burn, so coal and charcoal stay for torches. */
export function plankFuel (bot: Bot): string | undefined {
  return Object.entries(inventoryCounts(bot)).filter(([k]) => /_planks$/.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** Glass from sand nearby, smelted. */
async function ensureGlass (ctx: Ctx, need: number, radius: number, notes: string[], placedFurnaces: { x: number, y: number, z: number }[]): Promise<void> {
  const { bot, signal, log } = ctx
  const have = () => inventoryCounts(bot).glass ?? 0
  if (have() >= need) return
  const sand = () => inventoryCounts(bot).sand ?? 0
  if (sand() < need - have()) {
    if (!ctx.agent.canDig || !findExposed(bot, 'sand', radius)) { notes.push(`no sand within ${radius} blocks for glass`); return }
    const r = await withBudget(ctx, EXTRA_MS, c => collectBlocks(c, 'sand', need - have() - sand()))
    if (!r.ok) { notes.push(`glass: ${r.message}`); return }
  }
  checkAborted(signal)
  if (!await ensureFurnace(ctx, radius, notes)) return
  const r = await smeltItem(bot, signal, log, 'sand', Math.min(sand(), need - have()), plankFuel(bot))
  log.debug('gather: glass', { ok: r.ok, result: r.message })
  const placed = (r.data as { placed?: { x: number, y: number, z: number } } | undefined)?.placed
  if (placed) placedFurnaces.push(placed)
  if (!r.ok) notes.push(`glass: ${r.message}`)
}

/**
 * Smelts and crafts the stone family's intermediates for a shopping list: cobblestone into
 * stone, stone into smooth stone, stone into stone bricks, bricks into cracked bricks. Works
 * from what the inventory holds now (stoneChain), so a second call does nothing extra.
 */
async function makeStone (ctx: Ctx, all: Record<string, number>, radius: number, notes: string[], placedFurnaces: { x: number, y: number, z: number }[]): Promise<void> {
  const { bot, signal, log } = ctx
  const craftBricks = async () => {
    const n = stoneChain(all, inventoryCounts(bot)).brickCrafts
    if (!n) return
    const r = await craftItem(bot, signal, 'stone_bricks', n * 4).catch(e => fail((e as Error).message))
    if (!r.ok) notes.push(`stone bricks: ${r.message}`)
  }
  for (const [out, from] of STONE_SMELTS) {
    checkAborted(signal)
    if (out === 'cracked_stone_bricks') await craftBricks()
    const n = stoneChain(all, inventoryCounts(bot)).smelt[out] ?? 0
    if (!n) continue
    if (!(inventoryCounts(bot)[from] ?? 0)) { notes.push(`no ${from} to smelt into ${out}`); continue }
    if (!await ensureFurnace(ctx, radius, notes)) return
    const r = await smeltItem(bot, signal, log, from, n, plankFuel(bot))
    log.debug('gather: smelt stone', { out, from, n, ok: r.ok, result: r.message })
    const placed = (r.data as { placed?: { x: number, y: number, z: number } } | undefined)?.placed
    if (placed) placedFurnaces.push(placed)
    if (!r.ok) notes.push(`${out}: ${r.message}`)
  }
  await craftBricks()
}

/** Wool of one colour from sheep nearby (never pets, named, penned or protected ones). Returns the colour with enough, or null. */
async function ensureWool (ctx: Ctx, need: number, radius: number, notes: string[]): Promise<string | null> {
  const { bot, agent, signal, log } = ctx
  const best = () => {
    const inv = inventoryCounts(bot)
    return Object.entries(inv).filter(([k]) => /_wool$/.test(k)).sort((a, b) => b[1] - a[1])[0] ?? null
  }
  const skipped = new Set<number>()
  for (let tries = 0; tries < need + 3; tries++) {
    const b = best()
    if (b && b[1] >= need) return b[0].replace(/_wool$/, '')
    checkAborted(signal)
    const sheep = bot.nearestEntity(e => {
      if (e.name !== 'sheep' || skipped.has(e.id) || e.position.distanceTo(bot.entity.position) > radius) return false
      const keys = (bot.registry as any).entitiesByName?.sheep?.metadataKeys as string[] | undefined
      if (huntRefusal(e as HuntCandidate, { animals: ['sheep'], metadataKeys: keys })) return false
      return !agent.protectedAreas.isProtected(e.position) && !inPen(bot, e)
    })
    if (!sheep) { if (tries === 0) notes.push(`no sheep within ${radius} blocks for a bed`); break }
    log.debug('gather: sheep for wool', { id: sheep.id })
    const dead = await fight(bot, sheep, signal, 25_000)
    if (!dead) { skipped.add(sheep.id); continue }
    await sleep(400, signal)
    await pickupNearby(bot, signal, { radius: 6, maxMs: 8000 })
  }
  const b = best()
  if (b && b[1] >= need) return b[0].replace(/_wool$/, '')
  if (b) notes.push(`only ${b[1]} ${b[0]} for a bed`)
  return null
}

/**
 * Gathers and crafts a shopping list. Reports what it got and, truthfully, what is still
 * missing and why. ok only when every required item is there.
 */
export async function gatherMaterials (ctx: Ctx, wants: Record<string, number>, opts: GatherOptions = {}): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  const radius = opts.radius ?? 32
  const all = { ...opts.optional, ...wants }
  const start = inventoryCounts(bot)
  const isDone = (m: Record<string, number>, inv: Record<string, number>) => Object.entries(m).every(([k, n]) => countWant(k, inv) >= n)
  if (isDone(wants, start) && isDone(opts.optional ?? {}, start)) {
    return ok(`already have everything: ${fmtList(all)}`)
  }
  if (isCreative(bot)) {
    // creative: everything comes from the creative inventory, nothing is chopped, mined or crafted
    const theme = opts.theme ?? pickTheme(start) ?? undefined
    const take = creativeStock(all, start, theme)
    const r = await takeFromCreative(bot, signal, take)
    const inv = inventoryCounts(bot)
    const missing = Object.entries(wants).filter(([k, n]) => countWant(k, inv) < n).map(([k, n]) => `${n - countWant(k, inv)} ${k}`)
    const msg = `creative: took ${r.taken} items from the creative inventory${r.unknown.length ? ` (unknown: ${r.unknown.join(', ')})` : ''}`
    log.debug('gather: creative', { take: JSON.stringify(take), taken: r.taken })
    return missing.length ? fail(`${msg}; still missing ${missing.join(', ')} (inventory full?)`, { taken: r.taken }) : ok(msg, { taken: r.taken })
  }
  const tableId = bot.registry.blocksByName.crafting_table?.id
  const furnaceId = bot.registry.blocksByName.furnace?.id
  const haveTable = () => tableId !== undefined && !!bot.findBlock({ matching: tableId, maxDistance: 16 })
  const haveFurnace = () => furnaceId !== undefined && !!bot.findBlock({ matching: furnaceId, maxDistance: 32 })
  const notes: string[] = []
  const placedFurnaces: { x: number, y: number, z: number }[] = []
  const t0 = Date.now()
  // cheap tool upgrades first (stone tools once a wooden pickaxe exists): every later dig is faster
  const upNote = agent.canDig ? await autoUpgrade(ctx) : ''
  const planNow = () => planWood(all, inventoryCounts(bot), { haveTable: haveTable(), haveFurnace: haveFurnace() })

  // 1. wood: chop until the plan has enough logs
  let trees = 0
  let misses = 0
  let plan = planNow()
  if (plan.logsToChop > 0 && !agent.canDig) return fail(`need ${plan.logsToChop} more logs but digging is disabled for this bot`)
  const maxTrees = opts.maxTrees ?? Math.min(40, Math.max(16, Math.ceil(plan.logsToChop / 3) + 4))
  while (plan.logsToChop > 0 && trees < maxTrees && misses < 2) {
    checkAborted(signal)
    log.debug('gather: chopping', { logsToChop: plan.logsToChop, trees })
    // a full inventory leaves the logs on the ground: throw junk out first, stop if that isn't enough
    const thrown = await makeRoom(bot, 3, new Set(Object.keys(all)))
    if (thrown) notes.push(`threw away ${thrown} to make room`)
    if (bot.inventory.emptySlotCount() === 0) { notes.push('inventory full, stopped chopping'); break }
    const r = await fellTree(ctx, { radius, replant: true, makeAxe: plan.makeAxe })
    if (r.ok) { trees++; misses = 0 } else { misses++; notes.push(r.message) }
    if (!r.ok && /no (natural )?tree|allowed to cut|disabled/.test(r.message)) break
    plan = planNow()
  }
  const theme = opts.theme && WOOD_SET.has(opts.theme) ? opts.theme : pickTheme(inventoryCounts(bot)) ?? undefined
  log.debug('gather: wood done', { trees, logsToChop: plan.logsToChop, planks: plan.planks, sticks: plan.sticks, mine: JSON.stringify(plan.mine), theme, inv: JSON.stringify(inventoryCounts(bot)) })

  // 2. intermediate crafting: planks (keeping the logs the build places as blocks), sticks
  checkAborted(signal)
  await ensurePlanks(bot, signal, plan.planks, msg => notes.push(`planks: ${msg}`))
  if (plan.sticks > 0) await ensureSticks(bot, signal, plan.sticks)

  log.debug('gather: crafted planks and sticks', { inv: JSON.stringify(inventoryCounts(bot)) })
  // 3. mined blocks: cobblestone (a pickaxe is made first), dirt, sand, gravel
  for (const [item, want] of Object.entries({ ...plan.mine })) {
    const base = countWant(item, inventoryCounts(bot))
    if (item === 'cobblestone' || item === 'stone') {
      // the whole amount in one strip mine (stone tools after the first 3), not 64 at a time
      checkAborted(signal)
      const r = await gatherStone(ctx, want)
      if (!r.ok || countWant(item, inventoryCounts(bot)) - base < want) notes.push(r.message)
      continue
    }
    for (const source of MINE_SOURCES[item] ?? []) {
      const left = want - (countWant(item, inventoryCounts(bot)) - base)
      if (left <= 0) break
      checkAborted(signal)
      const r = await collectBlocks(ctx, source, Math.min(64, left))
      if (!r.ok) notes.push(r.message)
    }
  }

  // 3b. stone family: cobblestone smelted into stone (and on into smooth stone), stone bricks
  if (Object.keys(all).some(k => STONE_INTERMEDIATE.has(k) || stoneRecipe(k))) await makeStone(ctx, all, radius, notes, placedFurnaces)

  // 4. extras that need smelting or animals: coal/charcoal for torches, glass, wool
  const missingOf = (k: string) => Math.max(0, (all[k] ?? 0) - countWant(k, inventoryCounts(bot)))
  if (missingOf('torch') > 0) await ensureCoal(ctx, Math.ceil(missingOf('torch') / 4), radius, notes, placedFurnaces)
  const panes = missingOf('glass_pane')
  if (panes > 0 || missingOf('glass') > 0) await ensureGlass(ctx, Math.ceil(panes / 16) * 6 + missingOf('glass'), radius, notes, placedFurnaces)
  let woolColor: string | null = null
  const woolNeed = missingOf('bed') * 3 + Math.ceil(missingOf('carpet') / 3) * 2
  if (woolNeed > 0) woolColor = await ensureWool(ctx, missingOf('bed') ? 3 : 2, radius, notes)

  // 5. the items themselves; stations last, since crafting may put the table down
  const LAST = ['crafting_table', 'chest', 'furnace']
  const items = Object.entries(all).sort(([a], [b]) => Number(LAST.includes(a)) - Number(LAST.includes(b)) || Number(b === 'glass_pane') - Number(a === 'glass_pane'))
  for (const [item, want] of items) {
    checkAborted(signal)
    const have = countWant(item, inventoryCounts(bot))
    if (have >= want) continue
    if (item === 'planks' || item === 'log' || item === 'logs' || item === 'stick' || /_planks$/.test(item) || planksFor(item)) {
      if (/_planks$/.test(item) && item !== 'planks') await craftItem(bot, signal, item, want - have).catch(() => fail(''))
      continue
    }
    if (MINE_SOURCES[item] || item === 'glass' || item === 'coal' || (STONE_INTERMEDIATE.has(item) && item !== 'stone_bricks')) continue
    if (item === 'torch' && !countWant('coal', inventoryCounts(bot))) { notes.push('torches need coal or charcoal'); continue }
    if (item === 'glass_pane' && (inventoryCounts(bot).glass ?? 0) < 6) continue
    if ((item === 'bed' || item === 'carpet' || /_(bed|carpet)$/.test(item)) && !woolColor) continue
    if (item === 'furnace' && placedFurnaces.length) continue // picked up below
    const r = woodRecipe(item) ?? stoneRecipe(item)
    if (!r) continue
    const name = concreteName(item, inventoryCounts(bot), theme, woolColor)
    if (!name) { notes.push(`no planks to make a ${item} from`); continue }
    let res = await craftItem(bot, signal, name, want - have).catch(e => fail((e as Error).message))
    if (!res.ok) {
      // the inventory can lag right after a furnace or a pickup: give it a moment and try once more
      await sleep(1000, signal)
      res = await craftItem(bot, signal, name, want - countWant(item, inventoryCounts(bot))).catch(e => fail((e as Error).message))
    }
    log.debug('gather: craft', { item: name, want: want - have, ok: res.ok, result: res.message })
    if (!res.ok) notes.push(res.message)
  }
  // a furnace put down for smelting goes back in the bag when the build wants one
  if (missingOf('furnace') > 0 && placedFurnaces.length) await pickUpStation(ctx, placedFurnaces[0]!, 'furnace', notes)
  else if (missingOf('furnace') > 0 && countWant('cobblestone', inventoryCounts(bot)) >= 8) await craftItem(bot, signal, 'furnace', 1).catch(() => fail(''))
  // the crafting table may have been put down to craft with; a wanted one is cheap to make again
  if (missingOf('crafting_table') > 0) await craftItem(bot, signal, 'crafting_table', missingOf('crafting_table')).catch(() => fail(''))

  // 6. optional items that couldn't be had: their fallbacks (fences for missing glass)
  const fb: Record<string, number> = {}
  for (const [item, alt] of Object.entries(opts.fallbacks ?? {})) {
    const left = missingOf(item)
    if (!left || !opts.optional?.[item]) continue
    for (const [k, n] of Object.entries(alt)) fb[k] = (fb[k] ?? 0) + Math.min(n, left)
  }
  let fbNote = ''
  if (Object.keys(fb).length) {
    // fallbacks are wanted on top of whatever the build already needs of the same item
    const extra = Object.fromEntries(Object.entries(fb).map(([k, n]) => [k, n + (wants[k] ?? 0)]))
    const r = await gatherMaterials(ctx, {}, { radius, optional: extra, maxTrees: 4, theme })
    fbNote = `; instead of ${Object.keys(opts.fallbacks ?? {}).filter(k => missingOf(k) > 0).join(', ')}: ${r.message}`
  }

  // 7. report: required items first, optional extras separately, and why things are missing
  const inv = inventoryCounts(bot)
  const short = (m: Record<string, number>) => Object.entries(m).filter(([k, n]) => countWant(k, inv) < n).map(([k, n]) => `${n - countWant(k, inv)} ${k}`)
  const missingReq = short(wants)
  const missingOpt = short(opts.optional ?? {})
  const unsupported = planWood(wants, inv).unsupported.filter(k => countWant(k, inv) < (wants[k] ?? 0))
  const why = [...new Set(notes)].slice(0, 3).join('; ')
  const secs = Math.round((Date.now() - t0) / 1000)
  const treeNote = `${upNote}${trees ? `felled ${trees} tree${trees === 1 ? '' : 's'}, ` : ''}`
  const have = `have ${Object.keys(wants).map(k => `${countWant(k, inv)}/${wants[k]} ${k}`).join(', ')}`
  const optNote = missingOpt.length ? `; no ${missingOpt.join(', ')} (optional${why && !missingReq.length ? `: ${why}` : ''})` : ''
  const data = { have: Object.fromEntries(Object.keys(all).map(k => [k, countWant(k, inv)])), trees, skipped: missingOpt, ms: Date.now() - t0 }
  log.info('gathered', { secs, trees, have: JSON.stringify(data.have) })
  if (!missingReq.length) return ok(`${treeNote}${have}${optNote}${fbNote} in ${secs}s`, data)
  const cant = unsupported.length ? `; I can't make ${unsupported.join(', ')} myself` : ''
  return fail(`${treeNote}${have}; still missing ${missingReq.join(', ')}${cant}${why ? ` (${why})` : ''}${optNote}${fbNote} after ${secs}s`, data)
}

/**
 * Creative mode: what to take from the creative inventory for a shopping list (pure). Generic
 * names become the theme's wood (oak by default) or white wool items; only what's missing.
 */
export function creativeStock (wants: Record<string, number>, inv: Record<string, number>, theme?: string): Record<string, number> {
  const wood = theme && (WOODS as readonly string[]).includes(theme) ? theme : 'oak'
  const take: Record<string, number> = {}
  for (const [key, want] of Object.entries(wants)) {
    const missing = want - countWant(key, inv)
    if (missing <= 0) continue
    let item = key
    if (key === 'planks') item = `${wood}_planks`
    else if (key === 'log' || key === 'logs') item = `${wood}_log`
    else if (['door', 'trapdoor', 'slab', 'stairs', 'fence', 'fence_gate'].includes(key)) item = `${wood}_${key}`
    else if (key === 'bed' || key === 'carpet') item = `white_${key}`
    else if (key === 'coal') item = 'coal'
    take[item] = (take[item] ?? 0) + missing
  }
  return take
}

/** Breaks a station the bot put down earlier and picks it up. */
async function pickUpStation (ctx: Ctx, at: { x: number, y: number, z: number }, name: string, notes: string[]): Promise<void> {
  const { bot, signal } = ctx
  const b = bot.blockAt(bot.entity.position.clone().set(at.x, at.y, at.z))
  if (!b || b.name !== name) return
  try {
    await ensureTool(bot, signal, 'pickaxe', { cheapOnly: true })
    const pick = bot.inventory.items().find(i => /_pickaxe$/.test(itemName(i)))
    if (pick) await bot.equip(pick, 'hand')
    await gotoWithin(bot, new goals.GoalLookAtBlock(b.position, bot.world), signal, 20_000)
    await digBlock(bot, b, signal)
    await sleep(300, signal)
    await pickupNearby(bot, signal, { radius: 6, item: name, maxMs: 8000 })
  } catch (e) {
    checkAborted(signal)
    notes.push(`couldn't pick the ${name} back up: ${(e as Error).message}`)
  }
}

/**
 * A concrete item for a generic name: "door" -> "spruce_door" in the theme's wood when there
 * are planks of it, else the planks we have most of; "bed" -> "white_bed" in the wool's colour.
 */
export function concreteName (item: string, inv: Record<string, number>, theme?: string, woolColor?: string | null): string | null {
  if (item === 'bed' || item === 'carpet') return woolColor ? `${woolColor}_${item}` : null
  if (!['door', 'trapdoor', 'slab', 'stairs', 'fence', 'fence_gate'].includes(item)) return item
  if (theme && (inv[`${theme}_planks`] ?? 0) > 0) return `${theme}_${item}`
  const plank = Object.entries(inv).filter(([k]) => /_planks$/.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0]
  return plank ? `${plank.replace(/_planks$/, '')}_${item}` : null
}

const gatherAction = defineAction({
  name: 'gather_materials',
  description: 'Get the materials for a job in one go: chops as many trees as needed (crafting a wooden axe first), turns logs into planks and sticks, ' +
    'crafts wooden items (stairs, slabs, fences, doors, trapdoors, ladders, crafting tables, chests, tools), mines cobblestone with a pickaxe and other simple blocks, ' +
    'makes the stone family (cobblestone/stone/stone brick slabs, stairs and walls, stone bricks, smooth stone; smelting cobblestone into stone in a furnace), ' +
    'and tries for the extras: torches (coal, or charcoal smelted from logs), glass panes (sand smelted into glass), a bed (wool from sheep nearby). ' +
    'Extras it can\'t get are skipped and reported. Give either items, e.g. {"planks": 80, "door": 1} ("planks", "log", "door", "stairs", "slab", "fence", "bed" mean any wood/colour), ' +
    'or template="small_house" for everything a blueprint needs. Prefer this over many chop_tree/craft calls. Needs digging enabled to chop or mine.',
  params: z.object({
    items: z.record(z.string(), z.number().int().min(1).max(512)).optional().describe('item -> count, e.g. {"oak_planks": 64, "stick": 8, "door": 1}'),
    template: z.string().optional().describe('blueprint name (see build_plan) to gather everything it needs'),
    material: z.string().optional().describe('with template: the main block to use, e.g. spruce_planks or cobblestone'),
    theme: z.string().optional().describe('wood to build with: oak, spruce, birch, dark_oak...; default whatever wood the bot has most of'),
    radius: z.number().int().min(8).max(64).default(32).describe('how far to look for trees and blocks')
  }),
  longRunning: true,
  async run (ctx, { items, template, material, theme, radius }) {
    let wants: Record<string, number> = { ...items }
    let optional: Record<string, number> = {}
    let fallbacks: Record<string, Record<string, number>> = {}
    let note = ''
    if (template && !material) {
      // No material named: pick the cheaper one here (cobblestone with few trees, planks without a pickaxe).
      const pick = pickBuildMaterial(ctx, template)
      if (pick) { material = pick.material; note = pick.why }
    }
    if (template) {
      // Only what is still missing at the site (a half-built house needs less).
      const w = remainingWants(ctx, template, material, theme)
      if (typeof w === 'string') return fail(w)
      wants = { ...w.required, ...wants }
      optional = w.optional
      fallbacks = w.fallbacks
      note = [note, w.note].filter(Boolean).join('; ')
    }
    if (!Object.keys(wants).length && !Object.keys(optional).length) return template ? ok(`nothing to gather: ${note || `the ${template} is complete`}`) : fail('nothing to gather: give items or a template')
    const r = await gatherMaterials(ctx, wants, { radius, optional, fallbacks, theme })
    return note ? { ...r, message: `${r.message} (${note})` } : r
  }
})

export const materialsSkill = () => defineSkill({
  name: 'materials',
  description: 'Gathering and crafting everything a job needs.',
  actions: [gatherAction]
})
