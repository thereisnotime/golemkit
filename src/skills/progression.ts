// Tool progression: wood -> stone -> iron -> diamond, the way a quick player does it.
// nextToolUpgrade() is a pure planner (unit tested): given the inventory, what is nearby and
// the game mode it returns the single next step towards better tools. upgradeTools() runs
// those steps (craft, mine cobblestone, fell a tree, make a furnace, charcoal, smelt iron).
// gather_materials, collect and big chops call autoUpgrade() first, which only does the
// cheap steps (stone tools cost 3 cobblestone and 2 sticks once a wooden pickaxe exists).
import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, needsSurvival } from '../core/index.ts'
import { TOOL_SHAPE, toolTier, inventoryCounts, plankUnits, usablePlankUnits, ensureTool, ensurePlanks, type ToolKind, type Tier } from './toolkit.ts'
import { craftItem, smeltItem } from './crafting.ts'
import { collectBlocks } from './gather.ts'
import { fellTree } from './woodcutting.ts'
import { takeWoodFromOwnChests, fmtTally } from './containers.ts'
import { mineStone, miningState, depthOk, type MiningState } from './mining.ts'
import { notReadyText, shieldWouldDo } from './minePlan.ts'
import { creativeGet } from './mods.ts'
import { plankFuel } from './materials.ts'
import { loadBlueprints } from './blueprint.ts'
import { chooseWallMaterial, PLANKS_PER_TREE } from './efficiency.ts'
import { actionTrip, isTurnBack } from './trip.ts'

export type UpTo = 'stone' | 'iron' | 'diamond'
const TIER_RANK: Record<string, number> = { none: 0, wooden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
const HEAD_ITEM: Record<'stone' | 'iron' | 'diamond', string> = { stone: 'cobblestone', iron: 'iron_ingot', diamond: 'diamond' }
const STONE_HEADS = ['cobblestone', 'cobbled_deepslate', 'blackstone']
export const ARMOUR: Record<string, number> = { iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4 }

/** What the bot knows about its surroundings (cheap to sense, see senseNearby). */
export interface Nearby {
  /** Natural stone it could mine within a short walk (exposed or a staircase away). Default true. */
  stone?: boolean
  /** Iron ore seen within range that it may go for (safe mining: shallow, or it is ready to go deep). */
  ironOre?: boolean
  /** Iron ore seen only deeper than mining.safeDepth while not ready (a cave trip it shouldn't make). */
  ironOreDeep?: boolean
  /** Coal ore seen within range. */
  coalOre?: boolean
  /** Diamond ore seen within range. */
  diamondOre?: boolean
  /** A furnace block within reach of a short walk. */
  furnace?: boolean
  /** Trees within range. Default true. */
  trees?: boolean
  /** A crafting table within reach (no 4 planks needed for one). */
  craftingTable?: boolean
}

export type UpgradeStep =
  | { do: 'craft', item: string, kind: ToolKind | 'armour', tier: Tier, why: string }
  | { do: 'gather', item: 'logs' | 'cobblestone' | 'raw_iron' | 'coal' | 'diamond', count: number, why: string }
  | { do: 'craft_furnace', why: string }
  | { do: 'smelt', input: string, count: number, fuel: string, why: string }
  | { do: 'creative_get', item: string, why: string }

export interface UpgradeOptions {
  /** Highest tier to aim for. Default iron. */
  upTo?: UpTo
  /** Tool kinds to keep upgraded, in order. Default pickaxe, sword, axe, shovel. */
  kinds?: ToolKind[]
  /** Also make iron armour once iron tools are done. Default false. */
  armour?: boolean
  /** No iron ore in sight: dig a staircase and strip to look for some. Default false. */
  prospect?: boolean
  /** Safe mining readiness (settings.mining): not ready means no prospecting and no deep ore; shieldFirst turns the first iron ingot into a shield. */
  mining?: { ready: boolean, shieldFirst?: boolean }
}

// the sword right after the pickaxe: combat (techniques, defend, bodyguard) assumes one
const DEFAULT_KINDS: ToolKind[] = ['pickaxe', 'sword', 'axe', 'shovel']
/** Up to this many raw iron are smelted with planks; more is worth making charcoal first. */
export const SMALL_BATCH = 3

/** Best tier held for a kind ('none' if no tool). */
export function heldTier (inv: Record<string, number>, kind: ToolKind): Tier | 'none' {
  let best = 0
  for (const [k, v] of Object.entries(inv)) if (v > 0) best = Math.max(best, toolTier(k, kind))
  return (Object.keys(TIER_RANK).find(t => TIER_RANK[t] === best) ?? 'none') as Tier | 'none'
}

const count = (inv: Record<string, number>, names: string[]) => names.reduce((n, k) => n + (inv[k] ?? 0), 0)
const fuelItems = (inv: Record<string, number>) => (inv.coal ?? 0) + (inv.charcoal ?? 0)
const logCount = (inv: Record<string, number>) => Object.entries(inv).reduce((n, [k, v]) => n + (/_(log|wood|stem|hyphae)$/.test(k) && !k.startsWith('stripped_') ? v : 0), 0)

/** Sticks still to make for the given kinds, in planks (2 planks -> 4 sticks). */
function stickPlanks (inv: Record<string, number>, sticks: number): number {
  return 2 * Math.ceil(Math.max(0, sticks - (inv.stick ?? 0)) / 4)
}

/**
 * The single next step towards better tools, or null when there is nothing (more) to do
 * right now. Pure. Order: a wooden pickaxe first, then stone for every kind (cheap), then iron
 * (pickaxe first), then diamond. A step that can't be done (no iron ore known) is skipped, so
 * the bot stops at the best tier it can reach.
 */
export function nextToolUpgrade (inv: Record<string, number>, nearby: Nearby, gameMode: string | undefined, opts: UpgradeOptions = {}): UpgradeStep | null {
  const upTo = opts.upTo ?? 'iron'
  const kinds = opts.kinds ?? DEFAULT_KINDS
  if (gameMode === 'spectator') return null
  if (gameMode === 'creative') {
    // Creative: no gathering. Get the best allowed pickaxe straight from the creative menu.
    for (const kind of kinds) {
      if (TIER_RANK[heldTier(inv, kind)]! < TIER_RANK[upTo]!) return { do: 'creative_get', item: `${upTo}_${kind}`, why: 'creative mode' }
    }
    return null
  }
  const trees = nearby.trees !== false
  const stoneNear = nearby.stone !== false
  const pick = TIER_RANK[heldTier(inv, 'pickaxe')]!

  // 0. a wooden pickaxe: everything else needs one
  if (pick === 0) {
    const table = inv.crafting_table || nearby.craftingTable ? 0 : 4
    const need = TOOL_SHAPE.pickaxe.head + stickPlanks(inv, 2) + table
    const wood = usablePlankUnits(inv)
    if (wood >= need) return { do: 'craft', item: 'wooden_pickaxe', kind: 'pickaxe', tier: 'wooden', why: 'no pickaxe' }
    if (!trees) return null
    return { do: 'gather', item: 'logs', count: Math.ceil((need - wood) / 4), why: 'wood for a wooden pickaxe' }
  }

  // 0b. no sword at all and no cobblestone for a stone one yet: a wooden sword, if the wood
  // also leaves sticks for the stone pickaxe (fighting with fists is what the bot did live)
  if (kinds.includes('sword') && heldTier(inv, 'sword') === 'none' && count(inv, STONE_HEADS) < TOOL_SHAPE.sword.head) {
    const table = inv.crafting_table || nearby.craftingTable ? 0 : 4
    // sticks for this sword and for every stone tool still to come
    const sticks = TOOL_SHAPE.sword.sticks + kinds.filter(k => TIER_RANK[heldTier(inv, k)]! < 2).reduce((n, k) => n + TOOL_SHAPE[k].sticks, 0)
    const need = TOOL_SHAPE.sword.head + stickPlanks(inv, sticks) + table
    if (usablePlankUnits(inv) >= need) return { do: 'craft', item: 'wooden_sword', kind: 'sword', tier: 'wooden', why: 'no sword' }
  }

  // 1. stone, for every kind below stone
  const belowStone = kinds.filter(k => TIER_RANK[heldTier(inv, k)]! < 2)
  if (belowStone.length) {
    const cobble = count(inv, STONE_HEADS)
    const k = belowStone.find(k => TOOL_SHAPE[k].head <= cobble)
    if (k) {
      if (usablePlankUnits(inv) >= stickPlanks(inv, TOOL_SHAPE[k].sticks)) return { do: 'craft', item: `stone_${k}`, kind: k, tier: 'stone', why: `${HEAD_ITEM.stone} for a stone ${k}` }
      if (trees) return { do: 'gather', item: 'logs', count: 1, why: `sticks for a stone ${k}` }
    } else if (stoneNear) {
      const heads = belowStone.reduce((n, k) => n + TOOL_SHAPE[k].head, 0)
      // stone tools are cheap: mine everything at once, plus 8 for a furnace when iron is next
      const furnace = upTo !== 'stone' && !nearby.furnace && !inv.furnace ? 8 : 0
      return { do: 'gather', item: 'cobblestone', count: heads + furnace - cobble, why: `stone ${belowStone.join(', ')}` }
    }
  }
  if (upTo === 'stone') return null

  // 2. iron: pickaxe first (it unlocks diamonds), then the rest, then armour
  const wantIron = kinds.filter(k => TIER_RANK[heldTier(inv, k)]! < 3)
  const armour = opts.armour ? Object.keys(ARMOUR).filter(a => !inv[a]) : []
  if ((wantIron.length || armour.length) && TIER_RANK[heldTier(inv, 'pickaxe')]! >= 2) {
    const step = ironStep(inv, nearby, wantIron, armour, trees, stoneNear, !!opts.prospect && opts.mining?.ready !== false, !!opts.mining?.shieldFirst)
    if (step) return step
  }
  if (upTo === 'iron') return null

  // 3. diamond, only from diamonds held or ore seen (needs an iron pickaxe to mine)
  const wantDiamond = kinds.filter(k => TIER_RANK[heldTier(inv, k)]! < 4)
  if (wantDiamond.length && TIER_RANK[heldTier(inv, 'pickaxe')]! >= 3) {
    const d = inv.diamond ?? 0
    const k = wantDiamond.find(k => TOOL_SHAPE[k].head <= d)
    if (k) return { do: 'craft', item: `diamond_${k}`, kind: k, tier: 'diamond', why: 'diamonds' }
    if (nearby.diamondOre) return { do: 'gather', item: 'diamond', count: TOOL_SHAPE[wantDiamond[0]!].head - d, why: `a diamond ${wantDiamond[0]}` }
  }
  return null
}

function ironStep (inv: Record<string, number>, nearby: Nearby, kinds: ToolKind[], armour: string[], trees: boolean, stoneNear: boolean, prospect: boolean, shieldFirst: boolean): UpgradeStep | null {
  const ingots = inv.iron_ingot ?? 0
  // safe mining wants a shield or armour before going deep: the first ingot (and 6 planks) is a shield
  if (shieldFirst && ingots >= 1 && !inv.shield && usablePlankUnits(inv) >= 6) return { do: 'craft', item: 'shield', kind: 'armour', tier: 'iron', why: 'a shield before mining deep' }
  const k = kinds.find(k => TOOL_SHAPE[k].head <= ingots)
  if (k) return { do: 'craft', item: `iron_${k}`, kind: k, tier: 'iron', why: 'iron ingots' }
  if (!kinds.length) {
    const a = armour.find(a => ARMOUR[a]! <= ingots)
    if (a) return { do: 'craft', item: a, kind: 'armour', tier: 'iron', why: 'iron ingots' }
  }
  // ingots for the next thing in line
  const nextNeed = kinds.length ? TOOL_SHAPE[kinds[0]!].head : ARMOUR[armour[0]!]!
  const raw = count(inv, ['raw_iron'])
  const missing = nextNeed - ingots
  const what = kinds.length ? `an iron ${kinds[0]}` : `an ${armour[0]}`
  // not enough raw iron for the next tool yet and more to be had: mine first, smelt once
  if (raw > 0 && raw < missing && (nearby.ironOre || (prospect && stoneNear))) return { do: 'gather', item: 'raw_iron', count: missing - raw, why: `${what} (have ${raw} raw iron)` }
  if (raw > 0) {
    // smelt what we have (all of it: one furnace trip), needs a furnace and fuel
    if (!nearby.furnace && !inv.furnace) {
      if (count(inv, STONE_HEADS) >= 8) return { do: 'craft_furnace', why: 'a furnace to smelt iron' }
      if (stoneNear) return { do: 'gather', item: 'cobblestone', count: 8 - count(inv, STONE_HEADS), why: 'a furnace' }
      return null
    }
    const n = raw
    const fuelNeed = Math.ceil(n / 8)
    if (fuelItems(inv) >= fuelNeed) return { do: 'smelt', input: 'raw_iron', count: n, fuel: (inv.coal ?? 0) >= fuelNeed ? 'coal' : 'charcoal', why: 'iron ingots' }
    // No coal. A few ingots: burn planks straight away (1.5 smelts each, no extra furnace run).
    const plankFuel = Math.ceil(n / 1.5)
    if (n <= SMALL_BATCH && plankUnits(inv) >= plankFuel) return { do: 'smelt', input: 'raw_iron', count: n, fuel: 'planks', why: 'iron ingots (planks as fuel, no coal)' }
    // More: charcoal from logs first (one log -> one charcoal = 8 smelts), burnt with planks.
    const logs = logCount(inv)
    const log = Object.keys(inv).find(k => /_(log|wood|stem)$/.test(k) && !k.startsWith('stripped_') && (inv[k] ?? 0) > 0)
    const spare = plankUnits(inv) - 4 * logs // planks held besides the logs
    const want = fuelNeed - fuelItems(inv)
    if (log && (spare >= 1 || logs >= 2)) return { do: 'smelt', input: log, count: Math.min(spare >= 1 ? logs : logs - 1, want), fuel: 'planks', why: 'charcoal to smelt iron' }
    if (nearby.coalOre) return { do: 'gather', item: 'coal', count: want, why: 'fuel to smelt iron' }
    if (trees) return { do: 'gather', item: 'logs', count: want + 1, why: 'logs for charcoal' }
    return null
  }
  if (nearby.ironOre && missing > 0) return { do: 'gather', item: 'raw_iron', count: missing, why: what }
  if (prospect && stoneNear && missing > 0) return { do: 'gather', item: 'raw_iron', count: missing, why: `${what} (no ore in sight: digging for some)` }
  return null
}

/** Steps that cost next to nothing (craft from what is held, or mine a few cobblestone for stone tools). */
export function isCheapStep (s: UpgradeStep): boolean {
  if (s.do === 'craft' || s.do === 'creative_get') return true
  if (s.do === 'gather') return s.item === 'cobblestone' && s.count <= 20
  if (s.do === 'craft_furnace') return true
  return false
}

// ------------------------------------------------------------------ sensing and running

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

function seen (ctx: Ctx, names: string[], radius: number, exposedOnly = false, accept?: (p: { x: number, y: number, z: number }) => boolean): boolean {
  const { bot } = ctx
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  if (!ids.length) return false
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: exposedOnly || accept ? 64 : 1 })
    .filter(p => !accept || accept(p))
  if (!exposedOnly) return found.length > 0
  // findBlocks also sees ore buried deep in loaded chunks; only ore with an open face is worth a trip
  return found.some(p => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .some(([dx, dy, dz]) => /^(air|cave_air|water)$/.test(bot.blockAt(p.offset(dx!, dy!, dz!))?.name ?? '')))
}

/**
 * What is around, for nextToolUpgrade. Ore counts when it has an open face within 24 blocks
 * (caves, cliffs, our tunnels) and, under safe mining while not ready, is no deeper than
 * mining.safeDepth (deeper ore shows up as ironOreDeep instead).
 */
export function senseNearby (ctx: Ctx, mining: MiningState = miningState(ctx.bot, ctx.agent.settings)): Nearby {
  const ok = (p: { x: number, y: number, z: number }) => depthOk(ctx.bot, mining, p)
  const iron = seen(ctx, ['iron_ore', 'deepslate_iron_ore'], 24, true, ok)
  return {
    stone: seen(ctx, ['stone', 'deepslate'], 32),
    ironOre: iron,
    ...(!iron && !mining.readiness.ready && mining.s.safe && seen(ctx, ['iron_ore', 'deepslate_iron_ore'], 24, true) ? { ironOreDeep: true } : {}),
    coalOre: seen(ctx, ['coal_ore', 'deepslate_coal_ore'], 24, true, ok),
    diamondOre: seen(ctx, ['diamond_ore', 'deepslate_diamond_ore'], 24, true, ok),
    furnace: seen(ctx, ['furnace'], 16),
    craftingTable: seen(ctx, ['crafting_table'], 16),
    trees: true
  }
}

function describe (s: UpgradeStep): string {
  switch (s.do) {
    case 'craft': return `craft a ${s.item}`
    case 'gather': return `get ${s.count} ${s.item} (${s.why})`
    case 'craft_furnace': return 'craft a furnace'
    case 'smelt': return `smelt ${s.count} ${s.input} with ${s.fuel}`
    case 'creative_get': return `take a ${s.item} from the creative menu`
  }
}

/** Runs one step. Returns ok/fail with what happened. */
export async function runUpgradeStep (ctx: Ctx, s: UpgradeStep, safe = true): Promise<ActionResult> {
  const { bot, signal } = ctx
  switch (s.do) {
    case 'creative_get': {
      const r = await creativeGet.run(ctx as ActionContext, { item: s.item, count: 1 })
      return typeof r === 'object' && r ? r : fail(`could not take a ${s.item}`)
    }
    case 'craft': {
      if (s.kind === 'armour') return craftItem(bot, signal, s.item, 1)
      const r = await ensureTool(bot, signal, s.kind, { minTier: s.tier })
      return r.ok ? ok(r.message) : r
    }
    case 'craft_furnace': return craftItem(bot, signal, 'furnace', 1)
    case 'smelt': {
      if (s.fuel === 'planks') await ensurePlanks(bot, signal, Math.ceil(s.count / 1.5))
      const fuel = s.fuel === 'planks' ? plankFuel(bot) : s.fuel
      return smeltItem(bot, signal, ctx.log, s.input, s.count, fuel)
    }
    case 'gather': {
      if (s.item === 'logs') return getWood(ctx, s.count)
      if (s.item === 'cobblestone') return mineStone(ctx, Math.max(1, s.count), { safe })
      if (s.item === 'raw_iron') return collectOre(ctx, ['iron_ore', 'deepslate_iron_ore'], s.count, 'raw_iron', safe)
      if (s.item === 'coal') return collectOre(ctx, ['coal_ore', 'deepslate_coal_ore'], s.count, 'coal', safe)
      return collectOre(ctx, ['diamond_ore', 'deepslate_diamond_ore'], s.count, 'diamond', safe)
    }
  }
}

/**
 * Wood for the next tool: logs or planks from the bot's own chests nearby first, then a tree
 * within 32 blocks. When neither works it fails with data.need = 'wood', so a wood behaviour
 * (chop_wood_loop, which searches wider rings) can pick it up instead of the same step failing
 * over and over.
 */
async function getWood (ctx: Ctx, logs: number): Promise<ActionResult> {
  const want = Math.max(2, logs * 4)
  const chest = await takeWoodFromOwnChests(ctx, want).catch(e => { checkAborted(ctx.signal); return { took: {}, units: 0, notes: [(e as Error).message] } })
  if (chest.units >= want) return ok(`took ${fmtTally(chest.took)} from my chest`)
  const r = await fellTree(ctx, { radius: 32, replant: true, makeAxe: true })
  const fromChest = chest.units ? `took ${fmtTally(chest.took)} from my chest, ` : ''
  if (r.ok) return ok(`${fromChest}${r.message}`)
  if (chest.units) return ok(`${fromChest}but ${r.message}`)
  return fail(`needs wood: ${r.message}, and no wood in my chests nearby${chest.notes.length ? ` (${chest.notes.join('; ')})` : ''}`, { need: 'wood' })
}

async function collectOre (ctx: Ctx, blocks: string[], n: number, item: string, safe = true): Promise<ActionResult> {
  let last: ActionResult = fail(`no ${blocks[0]} nearby`)
  const m = miningState(ctx.bot, ctx.agent.settings)
  const mining: MiningState = safe ? m : { ...m, s: { ...m.s, safe: false } }
  for (const b of blocks) {
    if (!seen(ctx, [b], 32, true, p => depthOk(ctx.bot, mining, p))) continue
    last = await collectBlocks(ctx, b, n, { safe })
    if (last.ok) return last
  }
  // none with an open face: prospect with a staircase down and a strip (ores beside it are mined)
  if (item === 'raw_iron' || item === 'coal') {
    if (mining.s.safe && !mining.readiness.ready) return fail(`${notReadyText(mining.readiness)}; no ${blocks[0]} within ${mining.s.safeDepth} blocks of the surface`, { notReady: true, need: mining.readiness.need })
    return mineStone(ctx, n, { item, sources: blocks, minDepth: item === 'raw_iron' ? 16 : 6, maxSteps: 64, safe })
  }
  return last
}

/** The planner's view of safe mining: ready, and whether a shield would close the gear gap. Ready when safe mining is off. */
export function miningGate (m: MiningState, safe = true): { ready: boolean, shieldFirst: boolean } {
  if (!safe || !m.s.safe) return { ready: true, shieldFirst: false }
  return { ready: m.readiness.ready, shieldFirst: shieldWouldDo(m.kit, m.s) }
}

export interface UpgradeRun extends UpgradeOptions {
  /** Apply safe mining (settings.mining). Default true. */
  safe?: boolean
  /** Only cheap steps (see isCheapStep). */
  cheapOnly?: boolean
  /** Most steps in one go. Default 12. */
  maxSteps?: number
  /** Before going for ore (an ore trip): pantry top-up, weapon, health, and the trip budget (skills/trip.ts). Null = go, else why not. */
  beginTrip? (): Promise<string | null>
}

const ORE_ITEMS = new Set(['raw_iron', 'coal', 'diamond'])

/**
 * Does the upgrade steps it can do now, one after another, until nothing is left, a step
 * fails or makes no progress. Reports every step truthfully.
 */
export async function upgradeTools (ctx: Ctx, opts: UpgradeRun = {}): Promise<ActionResult> {
  const { bot, log, agent } = ctx
  const done: string[] = []
  const notes: string[] = []
  let need: string | undefined
  const tiersBefore = toolSummary(inventoryCounts(bot), opts.kinds ?? DEFAULT_KINDS)
  let lastKey = ''
  let notReady = false
  let tripTried = false
  for (let i = 0; i < (opts.maxSteps ?? 12); i++) {
    checkAborted(ctx.signal)
    const inv = inventoryCounts(bot)
    const m = miningState(bot, agent.settings)
    const nearby = senseNearby(ctx, m)
    const planOpts: UpgradeOptions = { ...opts, mining: miningGate(m, opts.safe !== false) }
    const step = nextToolUpgrade(inv, nearby, bot.game?.gameMode, planOpts)
    if (!step) {
      // stuck only because it isn't fit to go underground: say so (and what to fix) instead of "nothing to do"
      const wouldDig = planOpts.mining && !planOpts.mining.ready ? nextToolUpgrade(inv, { ...nearby, ironOre: nearby.ironOre || nearby.ironOreDeep }, bot.game?.gameMode, { ...opts, mining: { ready: true } }) : null
      if (wouldDig?.do === 'gather') {
        // short of food for the mine: the trip preparation tops up from the pantry, then plan again
        if (opts.beginTrip && !tripTried && m.readiness.need === 'food') {
          tripTried = true
          const why = await opts.beginTrip()
          if (!why) continue
          notes.push(why)
        }
        notReady = true
        notes.push(`${notReadyText(m.readiness)}; would ${describe(wouldDig)} but that means going deeper than ${m.s.safeDepth} blocks`)
        need = m.readiness.need
      }
      break
    }
    if (opts.cheapOnly && !isCheapStep(step)) { notes.push(`next would be to ${describe(step)}`); break }
    if (step.do === 'gather' && !agent.canDig) { notes.push(`would ${describe(step)} but digging is disabled`); break }
    if (step.do === 'gather' && ORE_ITEMS.has(step.item) && opts.beginTrip && !tripTried) {
      tripTried = true
      const why = await opts.beginTrip()
      if (why) { notes.push(`would ${describe(step)}, but ${why}`); notReady = true; break }
    }
    const key = JSON.stringify(step) + JSON.stringify(inv)
    if (key === lastKey) { notes.push(`no progress on: ${describe(step)}`); break }
    lastKey = key
    log.debug('upgrade step', { step: describe(step) })
    const r = await runUpgradeStep(ctx, step, opts.safe !== false).catch(e => { checkAborted(ctx.signal); if (isTurnBack(e)) throw e; return fail((e as Error).message) })
    if (!r.ok) {
      notes.push(`${describe(step)} failed: ${r.message}`)
      need = (r.data as { need?: string } | undefined)?.need
      break
    }
    done.push(r.message)
  }
  const tiersAfter = toolSummary(inventoryCounts(bot), opts.kinds ?? DEFAULT_KINDS)
  const changed = tiersAfter !== tiersBefore
  const msg = `${done.length ? done.join('; ') : 'nothing to upgrade right now'}${notes.length ? ` (${notes.join('; ')})` : ''}; tools: ${tiersAfter}`
  if (!needsSurvival(bot) && !done.length) return ok(msg)
  if (notReady && !done.length) return fail(msg, { changed, tools: tiersAfter, notReady: true, ...(need ? { need } : {}) })
  return done.length || !notes.some(n => /failed/.test(n)) ? ok(msg, { changed, tools: tiersAfter, ...(need ? { need } : {}) }) : fail(msg, { changed, tools: tiersAfter, ...(need ? { need } : {}) })
}

export function toolSummary (inv: Record<string, number>, kinds: ToolKind[] = DEFAULT_KINDS): string {
  return kinds.map(k => `${heldTier(inv, k)} ${k}`).join(', ')
}

/**
 * Called before long gathers: does only the cheap upgrades (stone tools from a few cobblestone
 * once a wooden pickaxe exists). Returns a short note for the caller's report, '' if nothing changed.
 */
export async function autoUpgrade (ctx: Ctx, opts: UpgradeRun = {}): Promise<string> {
  if (!needsSurvival(ctx.bot) || !ctx.agent.canDig) return ''
  const inv = inventoryCounts(ctx.bot)
  if (TIER_RANK[heldTier(inv, 'pickaxe')]! === 0) return '' // nothing cheap before the first pickaxe
  // stone always (a few cobblestone); iron only when the iron is already in hand
  const upTo: UpTo = inv.iron_ingot || inv.raw_iron ? 'iron' : 'stone'
  const r = await upgradeTools(ctx, { upTo, ...opts, cheapOnly: true, maxSteps: 8 }).catch(e => { checkAborted(ctx.signal); return fail((e as Error).message) })
  return (r.data as { changed?: boolean } | undefined)?.changed ? `upgraded tools (${(r.data as { tools: string }).tools}), ` : ''
}

const upgradeAction = defineAction({
  name: 'upgrade_tools',
  description: 'Upgrade tools as far as possible right now: wooden pickaxe -> stone tools (mines the cobblestone) -> furnace from 8 cobblestone -> ' +
    'smelt iron (coal, or charcoal made from logs) -> iron tools -> diamond tools if it has diamonds. Covers pickaxe, sword, axe and shovel, armour optionally. ' +
    'Stops at the best tier it can reach and says what is missing (e.g. no iron ore seen). Safe mining: without a weapon, food (and a shield or armour if mining.gear asks) ' +
    'it only takes ore near the surface and says "not ready to mine: ..." instead of going into caves. In creative it just takes the tools.',
  params: z.object({
    up_to: z.enum(['stone', 'iron', 'diamond']).default('iron').describe('highest tier to aim for'),
    armour: z.boolean().default(false).describe('also make iron armour once iron tools are done'),
    kinds: z.array(z.enum(['pickaxe', 'axe', 'shovel', 'sword', 'hoe'])).optional().describe('tool kinds to upgrade; default pickaxe, sword, axe, shovel'),
    prospect: z.boolean().default(true).describe('when no iron ore is in sight, dig a staircase and strip mine to look for some'),
    safe: z.boolean().default(true).describe('safe mining (settings.mining): only go deeper than mining.safeDepth with a weapon, food and the gear it asks for; avoid caves, light tunnels, climb out when losing underground')
  }),
  longRunning: true,
  async run (ctx, { up_to, armour, kinds, prospect, safe }) {
    // going for ore is a trip: pantry food, a weapon and health first, home when food or daylight runs short
    const trip = actionTrip(ctx, { purpose: 'an ore trip', kind: 'ore' })
    try {
      return await trip.finish(await upgradeTools(ctx, { upTo: up_to, armour, kinds, prospect, safe, maxSteps: 30, beginTrip: () => trip.begin() }))
    } catch (e) {
      if (isTurnBack(e)) return trip.finish(fail(e.message))
      throw e
    } finally {
      trip.end()
    }
  }
})

export const progressionSkill = () => defineSkill({
  name: 'progression',
  capabilities: ['move', 'dig', 'craft'],
  description: 'Tool progression: stone, iron and diamond tools.',
  actions: [upgradeAction],
  observe: (_agent, bot) => ({ tools: toolSummary(inventoryCounts(bot)) })
})

// ------------------------------------------------------------------ stone and build material

/**
 * Gets `n` cobblestone the quick way: with only a wooden pickaxe it mines just enough for
 * stone tools first, upgrades, then strip-mines the rest with the stone pickaxe.
 */
export async function gatherStone (ctx: Ctx, n: number): Promise<ActionResult> {
  const notes: string[] = []
  const start = inventoryCounts(ctx.bot).cobblestone ?? 0
  if (TIER_RANK[heldTier(inventoryCounts(ctx.bot), 'pickaxe')]! < 2 && needsSurvival(ctx.bot)) {
    const first = await mineStone(ctx, Math.min(n, 3), { returnUp: false })
    notes.push(first.message)
    if (!first.ok) return fail(first.message)
    const up = await autoUpgrade(ctx)
    if (up) notes.push(up.replace(/, $/, ''))
  }
  const left = n - ((inventoryCounts(ctx.bot).cobblestone ?? 0) - start)
  if (left > 0) {
    const r = await mineStone(ctx, left)
    notes.push(r.message)
  }
  const got = (inventoryCounts(ctx.bot).cobblestone ?? 0) - start
  return got > 0 || n <= 0 ? ok(notes.join('; '), { got }) : fail(notes.join('; '))
}

/**
 * For a template whose material role takes both planks and cobblestone (fortress walls),
 * picks the cheaper one here. Returns null when the template has no such role. Planks come
 * back as `material: undefined` (any planks count).
 */
export function pickBuildMaterial (ctx: Pick<ActionContext, 'bot'>, template: string): { material: string | undefined, why: string } | null {
  const bp = loadBlueprints().blueprints.get(template)
  if (!bp) return null
  const role = Object.entries(bp.roles).find(([, r]) => r.material)
  if (!role) return null
  const accept = new RegExp(role[1].accept ?? `^${role[1].default}$`)
  if (!accept.test('cobblestone') || !accept.test('oak_planks')) return null
  const need = bp.cells.filter(c => c.role === role[0]).length
  const { bot } = ctx
  const inv = inventoryCounts(bot)
  const logIds = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped_')).map(b => b.id)
  // distinct trunks within 32 blocks (one log per column)
  const trunks = new Set(bot.findBlocks({ matching: logIds, maxDistance: 32, count: 600 }).map(p => `${p.x},${p.z}`)).size
  const stoneIds = ['stone', 'deepslate'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const w = {
    need,
    planks: plankUnits(inv),
    cobble: count(inv, STONE_HEADS),
    trees: trunks,
    stone: bot.findBlocks({ matching: stoneIds, maxDistance: 32, count: 1 }).length > 0,
    pickaxe: heldTier(inv, 'pickaxe') !== 'none' || plankUnits(inv) >= 5
  }
  const m = chooseWallMaterial(w)
  const why = m === 'cobblestone'
    ? `cobblestone ${role[0]}s: ${w.cobble >= need ? 'already have it' : w.trees * PLANKS_PER_TREE < need ? `only ${w.trees} trees around` : 'quicker to strip-mine than to fell trees'}`
    : `planks ${role[0]}s: ${w.planks >= need ? 'already have them' : !w.stone ? 'no stone around' : !w.pickaxe ? 'no pickaxe yet' : 'plenty of trees'}`
  return { material: m === 'cobblestone' ? 'cobblestone' : undefined, why }
}
