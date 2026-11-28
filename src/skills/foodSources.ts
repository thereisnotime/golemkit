// Food sources (foodSourcePlan.ts) in Minecraft: reading the world into a FoodSourceWorld,
// running the chosen source, and the actions behind the new ones: repair_farm (a bad farm
// repaired where it is), plot_farm (a farm on the base's reserved plot, no bucket needed) and
// fish (a rod from string and sticks, a hole in the ice when the lake is frozen).
// The decisions are pure (foodSourcePlan, farmRepairPlan, plotFarmPlan); this file reads blocks
// and does the digging and placing.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import type { Agent, ActionContext, ActionResult, SiteRecord } from '../core/index.ts'
import { defineAction, z, ok, fail, travel, sleep, checkAborted, fmtPos, goals, itemName } from '../core/index.ts'
import { siteBook } from '../core/sites.ts'
import { CROPS, TILLABLE, plantOn } from './farming.ts'
import { getHome, getPlaces, setPlace, sameDimension } from './navigation.ts'
import { digBlock, findItem, countItem, placeAt, reachBlock, vec, gotoWithin, isReplaceable } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { equipFor } from './toolkit.ts'
import { craftItem } from './crafting.ts'
import { takeItemsFromOwnChests, chestView, chestTotals } from './containers.ts'
import {
  getFarms, saveFarm, animalsAround, ripeBerries, shoreKelp, canSmeltKelp, surfaceWater, shoreIce, keepWaterOpen, farmingOptions,
  inventory, freezes, getHoe, tillAt, canPlace, torchesAvailable, holdNoSilk, pourWater, fillBucket, offLimits, seedsFromChests, breakPlantsFor,
  awayFromBuilds, ICE, type Farm
} from './food.ts'
import { seedCount, pickFarmSeed, breedPlan, BREED_FOOD, type CellKind, type SiteCandidate } from './foodPlan.ts'
import { herdSurplus } from './combat.ts'
import { rodPlan } from './fishPlan.ts'
import { farmSiteVerdict, nextFarmName, type FarmSiteCell } from './needPlan.ts'
import { coverItem, iceMakesWater } from './coldFarmPlan.ts'
import { planFarmRepair, farmRepairSettings, type FarmRepairPlan } from './farmRepairPlan.ts'
import {
  planPlotFarm, choosePlotWater, plotSeedNeed, plantableCells, hydrated, plotFarmSettings,
  type PlotCell, type PlotGround, type PlotAbove, type PlotWaterMode, type PlotFarmSettings
} from './plotFarmPlan.ts'
import { gatherFromSources } from './materialSources.ts'
import {
  chooseFoodSource, foodSourceSettings, foodSourceText, noteSourceRun,
  type FoodSourceWorld, type FoodSourceChoice, type FoodSourceName, type FoodSourceSettings
} from './foodSourcePlan.ts'

const FAILED_KEY = 'food.sources.failed'
const CHOICE_KEY = 'food.source'
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])
const PLANT = /^(short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|.*_tulip|snow)$/
const CROP_ABOVE = /^(wheat|carrots|potatoes|beetroots)$/
/** Ground on the plot that may be dug out and replaced with dirt. */
const AIR_OR_ICE = /^(air|cave_air|ice|packed_ice|blue_ice|frosted_ice|powder_snow)$/
const SWAPPABLE = /^(stone|cobblestone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|gravel|sand|red_sand|snow_block|clay|mud|podzol|mycelium|moss_block|polished_andesite|polished_diorite|polished_granite|stone_bricks|smooth_stone)$/

export function foodSettings (agent: Agent): FoodSourceSettings {
  const s = agent.settings as { food?: unknown, farming?: unknown } | undefined
  return foodSourceSettings(s?.food, s?.farming)
}

/** farming.plotWater (auto | water | dry), farming.plotSwap and the plot knobs (plotSize, plotMin, plotSeedRadius). */
export function plotSettings (agent: Agent): { water: PlotWaterMode, swap: boolean } & PlotFarmSettings {
  const f = (agent.settings as { farming?: unknown } | undefined)?.farming
  const o = f && typeof f === 'object' ? f as Record<string, unknown> : {}
  const w = o.plotWater
  return { water: w === 'water' || w === 'dry' ? w : 'auto', swap: o.plotSwap !== false, ...plotFarmSettings(f) }
}

// ------------------------------------------------------------------ reading a farm square

/** The cells of a farm square as the site check sees them (and which are wet above the ground); null when not loaded. */
export function readFarmCells (b: Bot, f: { x: number, y: number, z: number, size: number }): { cells: Record<string, FarmSiteCell>, over: string[] } | null {
  if (typeof b.blockAt !== 'function') return null
  const h = (Math.max(3, Math.min(9, f.size)) - 1) / 2
  const cells: Record<string, FarmSiteCell> = {}
  const over: string[] = []
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const g = b.blockAt(vec(b, f.x + dx, f.y, f.z + dz))
      const a = b.blockAt(vec(b, f.x + dx, f.y + 1, f.z + dz))
      if (!g || !a) return null
      const k = `${dx},${dz}`
      let c: FarmSiteCell = 'other'
      if (ICE.test(a.name) || ICE.test(g.name)) c = 'ice'
      else if (a.name === 'water' || g.name === 'water') c = 'water'
      else if (g.name === 'farmland') c = 'farmland'
      else if (TILLABLE.includes(g.name) && (a.name === 'air' || PLANT.test(a.name) || CROP_ABOVE.test(a.name))) c = 'tillable'
      if ((c === 'ice' || c === 'water') && !ICE.test(g.name) && g.name !== 'water') over.push(k)
      cells[k] = c
    }
  }
  return { cells, over }
}

// ------------------------------------------------------------------ sensing

const cache = new WeakMap<object, { at: number, w: FoodSourceWorld }>()
const SENSE_MS = 30_000

function plotSpot (agent: Agent): { x0: number, z0: number, size: number, y: number } | null {
  const s = agent.storage?.get<{ farm_plot?: { x0: number, z0: number, size: number, y: number } } | undefined>('projects.spots', undefined)
  const p = s?.farm_plot
  return p && typeof p.x0 === 'number' && typeof p.size === 'number' ? p : null
}

function plotCentre (p: { x0: number, z0: number, size: number, y: number }) {
  const h = Math.floor(p.size / 2)
  return { x: p.x0 + h, y: p.y, z: p.z0 + h }
}

/** Its plot farm on the base's plot (centred inside the plot's square, this dimension when known), or null. */
function plotFarmOn (agent: Agent, bot: Bot, spot: { x0: number, z0: number, size: number, y: number }): Farm | null {
  const dim = bot.game?.dimension
  const c = plotCentre(spot)
  return getFarms(agent).find(f => (!f.dim || !dim || f.dim === dim) && ((f.x === c.x && f.z === c.z) ||
    (f.kind === 'plot' && f.x >= spot.x0 && f.x < spot.x0 + spot.size && f.z >= spot.z0 && f.z < spot.z0 + spot.size))) ?? null
}

/** The plot grew past its farm (bigger, or moved): plot_farm extends the farm onto it. */
function plotOutgrows (farm: Farm, spot: { x0: number, z0: number, size: number, y: number }): boolean {
  const c = plotCentre(spot)
  return farm.kind === 'plot' && (spot.size > farm.size || farm.x !== c.x || farm.z !== c.z)
}

function foodCount (bot: Bot, items: Record<string, number>): number {
  const foods = (bot.registry as { foodsByName?: Record<string, unknown> }).foodsByName ?? {}
  return Object.entries(items).filter(([k]) => foods[k] && !BAD_FOOD.has(k)).reduce((n, [, v]) => n + v, 0)
}

function badFarmRecord (agent: Agent): SiteRecord | null {
  let bad: SiteRecord[] = []
  try { bad = siteBook(agent).bad('farm') } catch { return null }
  const home = getHome(agent)
  return bad.filter(r => r.pos).sort((a, b) => home ? Math.hypot(a.pos!.x - home.x, a.pos!.z - home.z) - Math.hypot(b.pos!.x - home.x, b.pos!.z - home.z) : 0)
    .sort((a, b) => Number(!!a.data?.repairGaveUp) - Number(!!b.data?.repairGaveUp))[0] ?? null
}

/** The world as the food-source registry sees it (cached for 30 s: score() asks every tick). */
export function senseFoodSources (agent: Agent, bot: Bot, now = Date.now()): FoodSourceWorld {
  const c = cache.get(agent)
  if (c && now - c.at < SENSE_MS) return { ...c.w, now, failed: failedSources(agent) }
  const inv = inventory(bot)
  const home = getHome(agent)
  const centre = home && sameDimension(bot, home) ? vec(bot, home.x, home.y, home.z) : bot.entity.position
  let stored: Record<string, number> = {}
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  const fs = farmingOptions(agent)
  const rs = farmRepairSettings((agent.settings as { farming?: unknown } | undefined)?.farming)
  const bad = badFarmRecord(agent)
  const farms = getFarms(agent).filter(f => !f.dim || !bot.game?.dimension || f.dim === bot.game.dimension)
  const spot = plotSpot(agent)
  const plotPlace = getPlaces(agent).farm_plot
  const pc = spot ? plotCentre(spot) : null
  const onPlot = spot ? plotFarmOn(agent, bot, spot) : null
  const grassIds = ['short_grass', 'grass', 'tall_grass'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const grass = !!agent.canDig && !!bot.findBlock?.({ matching: grassIds, maxDistance: 32 })
  const water = surfaceWater(bot, centre, 48, 4).length > 0 || (fs.iceWater && !!agent.canDig && shoreIce(bot, centre, 48, 8).some(i => i.below === 'water'))
  const herd = animalsAround(agent, bot, centre, 32, Object.keys(BREED_FOOD))
  const hunt = Object.values(herdSurplus(herd.adults, 2)).reduce((a, b) => a + b, 0)
  const planks = Object.entries(inv).filter(([k]) => k.endsWith('_planks')).reduce((n, [, v]) => n + v, 0)
  const logs = Object.entries(inv).filter(([k]) => /_(log|stem)$/.test(k) && !k.startsWith('stripped_')).reduce((n, [, v]) => n + v, 0)
  const forage = ripeBerries(bot, centre, 32).length + (canSmeltKelp(bot) ? shoreKelp(bot, centre, 32).length : 0)
  const w: FoodSourceWorld = {
    now,
    farms: farms.map(f => ({ name: f.name, kind: f.kind ?? 'field' })),
    badFarm: bad ? { name: bad.id, reason: bad.reason ?? bad.fault ?? 'bad', tries: Number(bad.data?.repairTries ?? 0), gaveUp: !!bad.data?.repairGaveUp } : null,
    badFarmMode: rs.badFarm,
    canDig: !!agent.canDig,
    canPlace: canPlace(agent),
    seeds: seedCount(inv),
    chestSeeds: seedCount(stored),
    grass,
    plot: spot && (!plotPlace || sameDimension(bot, plotPlace)) ? { known: true, used: farms.some(f => f.kind === 'plot' || (pc && f.x === pc.x && f.z === pc.z)), ...(onPlot && plotOutgrows(onPlot, spot) ? { grow: true } : {}) } : null,
    rod: !!inv.fishing_rod,
    canMakeRod: (inv.string ?? 0) >= 2 && ((inv.stick ?? 0) >= 3 || planks >= 2 || logs >= 1) || rodPlan({ inv, stored, canCraft: !!agent.getAction('craft') }).step !== 'none',
    water,
    breed: !!agent.getAction('breed') && !!breedPlan(herd.adults, inv, { maxHerd: 12 }),
    hunt: agent.getAction('hunt') ? hunt : 0,
    forage: agent.getAction('forage') ? forage : 0,
    stock: foodCount(bot, inv) + foodCount(bot, stored),
    failed: failedSources(agent)
  }
  cache.set(agent, { at: now, w })
  return w
}

export function failedSources (agent: Agent): FoodSourceWorld['failed'] {
  return agent.storage?.get<FoodSourceWorld['failed']>(FAILED_KEY, {}) ?? {}
}

/** The source to use now, remembered for status and observe. */
export function foodSourceChoice (agent: Agent, bot: Bot): FoodSourceChoice {
  const choice = chooseFoodSource(senseFoodSources(agent, bot), foodSettings(agent))
  try {
    const text = foodSourceText(choice)
    const prev = agent.storage.get<{ text?: string } | undefined>(CHOICE_KEY, undefined)
    if (prev?.text !== text) agent.storage.set(CHOICE_KEY, { text, active: choice.active, at: Date.now() })
  } catch {}
  return choice
}

/** The last choice's line ("food source: plot (...); skipped farm: ..."), or null. */
export function lastFoodSourceText (agent: Agent): string | null {
  return agent.storage?.get<{ text?: string } | undefined>(CHOICE_KEY, undefined)?.text ?? null
}

/** Runs a source once and remembers a failure so it is skipped for food.retryMinutes. */
export async function runFoodSource (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'> & { act: (name: string, params?: Record<string, unknown>) => Promise<ActionResult> }, choice: FoodSourceChoice, o: { size?: number, radius?: number, fence?: boolean, light?: boolean, spawnClearance?: number, place?: string } = {}): Promise<ActionResult> {
  const { agent } = ctx
  const name = choice.active
  if (!name) return fail(foodSourceText(choice))
  let r: ActionResult
  switch (name) {
    case 'repair': r = await ctx.act('repair_farm', {}); break
    case 'farm': r = await ctx.act('start_farm', {
      ...(o.place ? { place: o.place } : {}),
      ...(o.size ? { size: o.size } : {}), ...(o.radius ? { radius: o.radius } : {}),
      ...(o.fence !== undefined ? { fence: o.fence } : {}), ...(o.light !== undefined ? { light: o.light } : {}),
      ...(o.spawnClearance !== undefined ? { spawnClearance: o.spawnClearance } : {})
    }); break
    case 'plot': r = await ctx.act('plot_farm', {}); break
    case 'fish': r = await ctx.act('fish', {}); break
    case 'forage': r = await ctx.act('forage', {}); break
    case 'animals': {
      const w = senseFoodSources(agent, ctx.bot)
      r = w.breed ? await ctx.act('breed', {}) : await ctx.act('hunt', { count: 2, radius: 32, keepAtLeast: 2 })
      break
    }
  }
  try {
    agent.storage.set(FAILED_KEY, noteSourceRun(failedSources(agent), name, r.ok, r.message, Date.now(), foodSettings(agent)))
    cache.delete(agent)
  } catch {}
  return r.ok ? ok(`${name}: ${r.message}`, r.data) : fail(`${name}: ${r.message}`, r.data)
}

// ------------------------------------------------------------------ fill blocks

const FILL = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack']
const fillItem = (bot: Bot, dirtOnly = false) => (dirtOnly ? ['dirt'] : FILL).find(n => countItem(bot, n) > 0) ?? null
const fillCount = (inv: Record<string, number>, dirtOnly = false) => (dirtOnly ? ['dirt'] : FILL).reduce((n, k) => n + (inv[k] ?? 0), 0)

/** Gets `n` fill blocks (dirt for ground that is tilled after): carried, its chests, then dug from grass just outside `around`. */
async function getFill (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, n: number, around: { x: number, y: number, z: number, h: number }, dirtOnly: boolean): Promise<string> {
  const { bot, agent, signal } = ctx
  const have = () => fillCount(inventory(bot), dirtOnly)
  if (have() >= n) return ''
  const notes: string[] = []
  try {
    const r = await takeItemsFromOwnChests(ctx, { dirt: n - have() }, 128, {}, chestView(agent, bot))
    if (r.took.dirt) notes.push(`took ${r.took.dirt} dirt from my chests`)
  } catch (e) { checkAborted(signal) }
  if (have() < n && agent.canDig) {
    let dug = 0
    for (let r = around.h + 2; r <= around.h + 6 && have() < n; r++) {
      for (let dx = -r; dx <= r && have() < n; dx++) {
        for (const dz of [-r, r]) {
          if (have() >= n) break
          const g = bot.blockAt(vec(bot, around.x + dx, around.y, around.z + dz))
          const up = bot.blockAt(vec(bot, around.x + dx, around.y + 1, around.z + dz))
          if (!g || !/^(grass_block|dirt|coarse_dirt)$/.test(g.name) || !up || !/^(air|snow|short_grass)$/.test(up.name)) continue
          if (offLimits(agent, bot, g.position, 0)) continue
          try { await reachBlock(bot, g.position, signal, 3, 15_000); await equipFor(bot, g).catch(() => {}); await digBlock(bot, g, signal); dug++ } catch (e) { checkAborted(signal) }
        }
      }
      await pickupNearby(bot, signal, { radius: 8, maxMs: 6000 }).catch(() => 0)
    }
    if (dug) notes.push(`dug ${dug} dirt`)
  }
  return notes.join(', ')
}

// ------------------------------------------------------------------ repair_farm

function farmOf (rec: SiteRecord): Farm | null {
  const f = rec.data as unknown as Farm | undefined
  if (f && typeof f.x === 'number') return { ...f, name: rec.id }
  if (!rec.pos) return null
  return { name: rec.id, x: rec.pos.x, y: rec.pos.y, z: rec.pos.z, size: 9, crop: 'wheat', created: Date.now(), ...(rec.pos.dim ? { dim: rec.pos.dim } : {}) }
}

/** Puts a farm back on its list, with its land cells recorded when it had none (older farms). */
function restoreFarm (agent: Agent, rec: SiteRecord, farm: Farm, cells: Record<string, FarmSiteCell>, note: string): void {
  const land = farm.land?.length ? farm.land : Object.entries(cells).filter(([k, v]) => k !== '0,0' && (v === 'farmland' || v === 'tillable')).map(([k]) => k)
  const next: Farm = { ...farm, land, tended: Date.now() }
  delete (next as { repairTries?: number }).repairTries
  delete (next as { repairGaveUp?: boolean }).repairGaveUp
  saveFarm(agent, next)
  setPlace(agent, farm.name, { x: farm.x, y: farm.y, z: farm.z, ...(farm.dim ? { dimension: farm.dim } : {}) })
  siteBook(agent).report({ kind: 'farm', id: farm.name, pos: { x: farm.x, y: farm.y, z: farm.z, ...(farm.dim ? { dim: farm.dim } : {}) }, label: `my farm ${farm.name}`, data: { ...next } }, { ok: true, note })
}

function markRecord (agent: Agent, rec: SiteRecord, data: Record<string, unknown>, handled?: string): void {
  const book = siteBook(agent)
  const cur = book.get(rec.kind, rec.id) ?? rec
  book.save({ ...cur, data: { ...(cur.data ?? {}), ...data }, ...(handled ? { handled } : {}) })
}

export async function repairFarm (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, p: { farm?: string, spawnClearance: number }): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  const rec = p.farm ? siteBook(agent).get('farm', p.farm.toLowerCase()) ?? null : badFarmRecord(agent)
  if (!rec) return fail(p.farm ? `no farm record called ${p.farm}` : 'none of my farms is marked bad')
  const farm = farmOf(rec)
  if (!farm) return fail(`${rec.id} has no position`)
  if (farm.dim && bot.game?.dimension && farm.dim !== bot.game.dimension) return fail(`${farm.name} is in ${farm.dim}`)
  if (Math.hypot(farm.x - bot.entity.position.x, farm.z - bot.entity.position.z) > 8) {
    try { await travel(bot, { x: farm.x, y: farm.y + 1, z: farm.z }, signal, { range: 4 }) } catch (e) { checkAborted(signal); return fail(`couldn't get to ${farm.name}: ${(e as Error).message}`) }
  }
  const read = readFarmCells(bot, farm)
  if (!read) return fail(`${farm.name} isn't loaded`)
  const fs = farmingOptions(agent)
  const rs = farmRepairSettings((agent.settings as { farming?: unknown } | undefined)?.farming)
  const inv = inventory(bot)
  let stored: Record<string, number> = {}
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  const tries = Number(rec.data?.repairTries ?? 0)
  const canKeepOpen = !freezes(bot, farm) || (fs.protectWater !== 'off' && canPlace(agent) && (!!coverItem(inv) || !!coverItem(stored) || torchesAvailable(bot) > 0 || !!agent.canDig))
  const plan: FarmRepairPlan = planFarmRepair({
    cells: read.cells,
    ...(farm.land ? { land: farm.land } : {}),
    over: read.over,
    mode: rs.badFarm,
    iceWater: fs.iceWater && !!agent.canDig,
    canKeepOpen,
    blocks: fillCount(inv, true) + (stored.dirt ?? 0),
    canDig: !!agent.canDig,
    canPlace: canPlace(agent),
    bucket: !!inv.water_bucket || !!inv.bucket,
    maxBlocks: rs.repairMaxBlocks,
    tries,
    maxTries: rs.repairTries
  })
  log.debug('repair_farm: plan', { farm: farm.name, decision: plan.decision, thaw: plan.thaw, fill: plan.fill.length, reason: plan.reason })
  if (plan.decision === 'restore') {
    restoreFarm(agent, rec, farm, read.cells, plan.reason)
    return ok(`${farm.name}: ${plan.reason}, back on my list`, { decision: plan.decision })
  }
  if (plan.decision === 'relocate') {
    markRecord(agent, rec, { repairGaveUp: true }, 'not worth repairing: a new farm elsewhere')
    return ok(`${farm.name}: ${plan.reason}`, { decision: plan.decision })
  }
  if (plan.decision === 'leave') {
    markRecord(agent, rec, { repairGaveUp: true }, 'left for the owners')
    siteBook(agent).tell(`${farm.name} at ${fmtPos(farm)} needs a hand: ${plan.reason}`)
    return fail(`${farm.name}: ${plan.reason}`, { decision: plan.decision })
  }

  markRecord(agent, rec, { repairTries: tries + 1 })
  const done: string[] = []
  const w = vec(bot, farm.x, farm.y, farm.z)
  if (plan.thaw) {
    const cells: Record<string, CellKind> = {}
    for (const [k, v] of Object.entries(read.cells)) cells[k] = v === 'farmland' || v === 'tillable' ? 'tillable' : v === 'water' || v === 'ice' ? 'water' : 'other'
    const cand: SiteCandidate = { water: { x: farm.x, y: farm.y, z: farm.z }, cells, around: [], distance: 0 }
    const r = await keepWaterOpen(ctx, cand, 'ice', fs)
    if (!r.ok) return fail(`${farm.name}: could not thaw the water: ${r.message}`)
    done.push(r.message)
  }
  if (plan.rewater) {
    try {
      if (!findItem(bot, 'water_bucket')) {
        const src = surfaceWater(bot, bot.entity.position, 48, 8).find(x => !x.equals(w))
        if (src) await fillBucket(bot, src, signal)
      }
      const b = bot.blockAt(w)
      if (b && b.name !== 'air' && b.name !== 'water' && TILLABLE.includes(b.name)) await digBlock(bot, b, signal)
      if (await pourWater(bot, w, signal)) done.push('put the water back')
    } catch (e) { checkAborted(signal) }
  }
  if (plan.fill.length) {
    const h = (farm.size - 1) / 2
    const note = await getFill(ctx, plan.fill.length, { x: farm.x, y: farm.y, z: farm.z, h }, true)
    if (note) done.push(note)
    let filled = 0
    for (const k of plan.fill) {
      checkAborted(signal)
      const [dx, dz] = k.split(',').map(Number) as [number, number]
      const pos = vec(bot, farm.x + dx, farm.y, farm.z + dz)
      try {
        const b = bot.blockAt(pos)
        if (b && ICE.test(b.name)) {
          // ice in the field: break it (it turns into water over the ground), then fill
          await holdNoSilk(bot)
          await reachBlock(bot, pos, signal, 3, 15_000)
          await digBlock(bot, b, signal)
        }
        const item = fillItem(bot, true)
        if (!item) break
        if (!isReplaceable(bot.blockAt(pos)?.name)) continue
        await placeAt(bot, item, pos, signal)
        filled++
      } catch (e) { checkAborted(signal) }
    }
    if (filled) done.push(`filled ${filled} of ${plan.fill.length} flooded cells with dirt`)
  }
  await sleep(500, signal)
  const after = readFarmCells(bot, farm)
  const v = after ? farmSiteVerdict(after.cells, farm.land) : null
  if (v?.ok && after) {
    restoreFarm(agent, rec, farm, after.cells, `repaired: ${done.join(', ')}`)
    return ok(`repaired ${farm.name}: ${done.join(', ') || plan.reason}; tend_farm tills and plants it again`, { decision: 'repair' })
  }
  return fail(`${farm.name}: tried to ${plan.reason} (${done.join(', ') || 'nothing worked'}), still ${v && !v.ok ? v.reason : 'not loaded'}`)
}

const repairFarmAction = defineAction({
  name: 'repair_farm',
  description: 'Look at one of its own farms that site health marked bad (flooded, frozen) and repair it where it is when that is ' +
    'a small job: break the frozen water in the middle and keep it open, fill flooded field cells with dirt, put the water back with a ' +
    'bucket. A farm that reads fine again goes back on its list. When the repair is too big (settings farming.badFarm, ' +
    'repairMaxBlocks, repairTries) it leaves the farm for a new one elsewhere, or for the owners.',
  capabilities: ['move', 'dig', 'place'],
  params: z.object({
    farm: z.string().optional().describe('which bad farm (farm:1...); default the nearest to home'),
    spawnClearance: z.number().min(0).max(256).default(48).describe('never dig within this distance of the world spawn')
  }),
  longRunning: true,
  run: (ctx, p) => repairFarm(ctx, p)
})

// ------------------------------------------------------------------ plot_farm

function plotGround (agent: Agent, bot: Bot, name: string, pos: Vec3, clearance: number): PlotGround {
  if (offLimits(agent, bot, pos, clearance)) return 'blocked'
  if (name === 'farmland') return 'farmland'
  if (name === 'water') return 'water'
  if (TILLABLE.includes(name)) return 'tillable'
  if (SWAPPABLE.test(name)) return 'swap'
  // a hole (air) gets dirt put in; ice and packed snow are dug out for dirt like stone
  if (AIR_OR_ICE.test(name)) return 'swap'
  return 'blocked'
}

function plotAbove (name: string): PlotAbove {
  if (name === 'air' || name === 'cave_air') return 'air'
  if (CROPS[name]) return 'crop'
  if (name === 'snow') return 'snow'
  if (PLANT.test(name)) return 'plant'
  if (/(^|_)torch$/.test(name)) return 'torch'
  return 'blocked'
}

/** Nothing that blocks movement above this column for 24 blocks: open sky (rain, snow, freezing). */
function openSky (bot: Bot, x: number, y: number, z: number): boolean {
  for (let dy = 1; dy <= 24; dy++) {
    const b = bot.blockAt(vec(bot, x, y + dy, z))
    if (!b) return true
    if (b.boundingBox === 'block') return false
  }
  return true
}

export async function plotFarm (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, p: { spawnClearance: number }): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  if (!agent.canDig) return fail('I need digging enabled to till the plot')
  const spot = plotSpot(agent)
  if (!spot) return fail('no farm plot kept in the base (the farm_plot base project keeps one)')
  const c = plotCentre(spot)
  // a farm already on the plot: the same square is done; a smaller one (the plot grew) is extended, keeping its name
  const prev = plotFarmOn(agent, bot, spot)
  if (prev && !plotOutgrows(prev, spot)) return fail(`the plot is already ${prev.name}`)
  const h = Math.floor(spot.size / 2)
  const toPlot = async (): Promise<string | null> => {
    if (Math.hypot(c.x - bot.entity.position.x, c.z - bot.entity.position.z) <= 6) return null
    try { await travel(bot, { x: c.x, y: c.y + 1, z: c.z }, signal, { range: 3 }); return null } catch (e) { checkAborted(signal); return (e as Error).message }
  }
  const away = await toPlot()
  if (away) return fail(`couldn't get to the farm plot at ${fmtPos(c)}: ${away}`)
  const steps: string[] = []
  const ps = plotSettings(agent)
  const fs = farmingOptions(agent)

  const read = (): PlotCell[] | null => {
    const out: PlotCell[] = []
    for (let dx = -h; dx <= h; dx++) {
      for (let dz = -h; dz <= h; dz++) {
        const gp = vec(bot, c.x + dx, c.y, c.z + dz)
        const g = bot.blockAt(gp)
        const a = bot.blockAt(gp.offset(0, 1, 0))
        if (!g || !a) return null
        const sky = (a as { skyLight?: number }).skyLight
        const light = (a as { light?: number }).light
        out.push({ dx, dz, ground: plotGround(agent, bot, g.name, gp, p.spawnClearance), name: g.name, above: plotAbove(a.name), sky: typeof sky === 'number' ? sky : null, block: typeof light === 'number' ? light : null })
      }
    }
    return out
  }
  const waterNear = (): { dx: number, dy: number, dz: number }[] => {
    const out: { dx: number, dy: number, dz: number }[] = []
    for (let dx = -h - 4; dx <= h + 4; dx++) {
      for (let dz = -h - 4; dz <= h + 4; dz++) {
        for (const dy of [0, 1]) if (bot.blockAt(vec(bot, c.x + dx, c.y + dy, c.z + dz))?.name === 'water') out.push({ dx, dy, dz })
      }
    }
    return out
  }
  let cells = read()
  if (!cells) return fail('the plot is not loaded')
  let water = waterNear()
  const centreCell = cells.find(x => x.dx === 0 && x.dz === 0)!

  // water for the centre (choosePlotWater): a bucket carried or in a container, ice, an empty bucket or 3 iron to fill one, else dry
  const inv0 = inventory(bot)
  let stored: Record<string, number> = {}
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  const wet = water.length > 0 && cells.filter(x => x.ground !== 'water').every(x => hydrated(x, water))
  const fillSpot = () => surfaceWater(bot, vec(bot, c.x, c.y, c.z), 64, 16)
    .find(w => !offLimits(agent, bot, w, p.spawnClearance) && !(w.x >= spot.x0 && w.x < spot.x0 + spot.size && w.z >= spot.z0 && w.z < spot.z0 + spot.size)) ?? null
  const choice = choosePlotWater({
    size: spot.size,
    mode: ps.water,
    near: wet || centreCell.ground === 'water',
    centreBlocked: centreCell.ground === 'blocked',
    waterBuckets: inv0.water_bucket ?? 0,
    storedWaterBuckets: stored.water_bucket ?? 0,
    buckets: (inv0.bucket ?? 0) + (stored.bucket ?? 0),
    iron: (inv0.iron_ingot ?? 0) + (stored.iron_ingot ?? 0),
    fillFrom: canPlace(agent) && spot.size >= 5 && !inv0.water_bucket && !stored.water_bucket && !!fillSpot(),
    ice: fs.iceWater && countItem(bot, 'ice') > 0
  })
  let waterNote = choice.reason
  const take = async (want: Record<string, number>): Promise<Record<string, number>> => {
    try { return (await takeItemsFromOwnChests(ctx, want, 128, {}, chestView(agent, bot))).took } catch (e) { checkAborted(signal); return {} }
  }
  if (canPlace(agent) && ['chest_bucket', 'fill', 'craft'].includes(choice.source)) {
    try {
      if (choice.source === 'chest_bucket') await take({ water_bucket: 1 })
      if (choice.source === 'fill' && !findItem(bot, 'bucket')) await take({ bucket: 1 })
      if (choice.source === 'craft') {
        if (countItem(bot, 'iron_ingot') < 3) await take({ iron_ingot: 3 - countItem(bot, 'iron_ingot') })
        const r = await craftItem(bot, signal, 'bucket', 1).catch(e => fail((e as Error).message))
        if (findItem(bot, 'bucket')) steps.push('crafted a bucket from 3 iron ingots')
        else waterNote = `${choice.reason}, but crafting it failed (${r.message})`
      }
      if ((choice.source === 'fill' || choice.source === 'craft') && findItem(bot, 'bucket') && !findItem(bot, 'water_bucket')) {
        const src = fillSpot()
        if (src && await fillBucket(bot, src, signal)) steps.push(`filled a bucket at ${fmtPos(src)}`)
      }
    } catch (e) { checkAborted(signal); waterNote = `${choice.reason}, but it failed (${(e as Error).message})` }
  }
  const bucket = choice.source !== 'near' && choice.source !== 'ice' && choice.source !== 'none' && !!findItem(bot, 'water_bucket')
  if (!bucket && choice.source !== 'near' && choice.source !== 'ice' && choice.source !== 'none' && waterNote === choice.reason) waterNote = `${choice.reason}, but I ended up without a water bucket`

  // seeds: what the plot can take against what it carries; chests first, then grass near home (not protected, not by somebody's build)
  const centreFree = choice.source === 'near' && centreCell.ground !== 'water'
  const need = plotSeedNeed({ cells: plantableCells(cells, centreFree), carried: seedCount(inventory(bot)), stored: stored.wheat_seeds ?? 0 })
  if (need.fromChests + need.fromGrass > 0) {
    if (need.fromChests) {
      const got = await seedsFromChests(ctx, 'wheat_seeds', need.fromChests + need.fromGrass).catch(e => { checkAborted(signal); return { took: 0 } })
      if (got.took) steps.push(`took ${got.took} wheat_seeds from my chests`)
    }
    const short = Math.max(0, need.want - seedCount(inventory(bot)))
    if (short > 0) {
      const home = getHome(agent)
      const centre = home && sameDimension(bot, home) ? { x: home.x, z: home.z } : { x: c.x, z: c.z }
      const got = await breakPlantsFor(ctx, short, p.spawnClearance, 3 * 60_000, ps.plotSeedRadius, undefined, { center: centre, keep: awayFromBuilds(agent, bot) })
        .catch(e => { checkAborted(signal); return { broken: 0, seeds: 0 } })
      if (got.broken) steps.push(`broke ${got.broken} grass within ${ps.plotSeedRadius} of home for ${got.seeds} seeds`)
    }
  }
  const seeds = seedCount(inventory(bot))
  const growingNow = cells.filter(x => x.above === 'crop').length
  if (!seeds && !growingNow) return fail(`no seeds for the plot${steps.length ? ` (${steps.join(', ')})` : ''}`)

  // dirt for the stone (the base's floor) the seeds will go on: carried, its chests, then the material sources
  const swapCells = cells.filter(x => x.ground === 'swap' && (x.above === 'air' || x.above === 'plant' || x.above === 'snow') && !(x.dx === 0 && x.dz === 0)).length
  const dirtWanted = ps.swap && canPlace(agent) ? Math.min(swapCells, seeds) - countItem(bot, 'dirt') : 0
  if (dirtWanted > 0) {
    const took = await take({ dirt: dirtWanted })
    if (took.dirt) steps.push(`took ${took.dirt} dirt from my chests`)
    const left = dirtWanted - (took.dirt ?? 0)
    if (left > 0) {
      const r = await gatherFromSources(ctx, { dirt: left }, { minutes: 3 }).catch(e => { checkAborted(signal); return fail((e as Error).message) })
      steps.push(r.ok ? `got ${left} dirt` : `short of dirt for ${left} stone cells (${r.message.slice(0, 80)})`)
    }
  }
  const back = await toPlot()
  if (back) return fail(`couldn't get back to the farm plot at ${fmtPos(c)}: ${back}${steps.length ? ` (${steps.join(', ')})` : ''}`)
  cells = read() ?? cells
  water = waterNear()

  const torchSpots: { dx: number, dz: number }[] = []
  const r = h + 1
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const g = bot.blockAt(vec(bot, c.x + dx, c.y, c.z + dz))
      const a = bot.blockAt(vec(bot, c.x + dx, c.y + 1, c.z + dz))
      if (g?.boundingBox === 'block' && (a?.name === 'air' || a?.name === 'snow') && !/chest|barrel|furnace|crafting/.test(g.name)) torchSpots.push({ dx, dz })
    }
  }
  const plan = planPlotFarm({
    size: spot.size,
    cells,
    water,
    iceItems: fs.iceWater ? countItem(bot, 'ice') : 0,
    bucket,
    plainBreak: true,
    freezes: freezes(bot, c) && openSky(bot, c.x, c.y, c.z),
    torches: canPlace(agent) ? torchesAvailable(bot) : 0,
    dirt: countItem(bot, 'dirt'),
    seeds: seedCount(inventory(bot)),
    torchSpots,
    mode: ps.water,
    swap: ps.swap && canPlace(agent)
  })
  log.debug('plot_farm: plan', { ok: plan.ok, water: plan.water, choice: choice.source, till: plan.till.length, swap: plan.swap.length, torches: plan.torches.length, reason: plan.reason })
  if (!plan.ok) return fail(`farm plot at ${fmtPos(c)}: ${plan.reason}${steps.length ? ` (${steps.join(', ')})` : ''}`)

  const hoe = await getHoe(ctx, p.spawnClearance)
  if (!hoe.ok) return fail(`no hoe: ${hoe.message}`)
  if (/crafted/.test(hoe.message)) steps.push(hoe.message)

  const at = (dx: number, dz: number, dy = 0) => vec(bot, c.x + dx, c.y + dy, c.z + dz)
  // stone cells: dig out, dirt in
  let swapped = 0
  for (const [dx, dz] of plan.swap) {
    checkAborted(signal)
    const g = bot.blockAt(at(dx, dz))
    if (!g || !findItem(bot, 'dirt')) break
    try { await reachBlock(bot, g.position, signal, 3, 15_000); if (!/air$/.test(g.name)) { await equipFor(bot, g).catch(() => {}); await digBlock(bot, g, signal) } await placeAt(bot, 'dirt', at(dx, dz), signal); swapped++ } catch (e) { checkAborted(signal) }
  }
  if (plan.swap.length) steps.push(`swapped ${swapped} of ${plan.swap.length} stone, ice or empty cells for dirt`)
  let waterHow: Farm['water'] = plan.water === 'near' ? 'natural' : plan.water === 'ice' ? 'ice' : plan.water === 'bucket' ? 'bucket' : 'none'
  // water from a bucket: a hole in the middle over something solid, the water poured in
  if (plan.water === 'bucket') {
    try {
      const below = bot.blockAt(at(0, 0, -1))
      if (below?.boundingBox !== 'block') throw new Error('nothing solid under the middle to hold the water')
      const g = bot.blockAt(at(0, 0))
      if (g && g.name !== 'air' && g.name !== 'water') { await reachBlock(bot, g.position, signal, 3, 15_000); await equipFor(bot, g).catch(() => {}); await digBlock(bot, g, signal) }
      if (bot.blockAt(at(0, 0))?.name === 'water' || await pourWater(bot, at(0, 0), signal)) steps.push('poured water in the middle')
      else { waterHow = 'none'; steps.push('the water would not go in the middle, so the plot is dry') }
    } catch (e) { checkAborted(signal); waterHow = 'none'; steps.push(`no water from the bucket (${(e as Error).message}), so the plot is dry`) }
  }
  // water from carried ice: a hole in the middle, the ice in it, broken without Silk Touch
  if (plan.water === 'ice') {
    try {
      const g = bot.blockAt(at(0, 0))
      if (g && g.name !== 'air') { await reachBlock(bot, g.position, signal, 3, 15_000); await digBlock(bot, g, signal) }
      await placeAt(bot, 'ice', at(0, 0), signal)
      const ice = bot.blockAt(at(0, 0))
      const below = bot.blockAt(at(0, 0, -1))
      if (ice && ICE.test(ice.name) && iceMakesWater({ below: below?.name ?? 'air', belowSolid: below?.boundingBox === 'block' })) {
        await holdNoSilk(bot)
        await digBlock(bot, ice, signal)
      }
      if (bot.blockAt(at(0, 0))?.name === 'water') steps.push('made water in the middle from ice I carried')
      else { waterHow = 'none'; steps.push('the ice made no water, so the plot is dry') }
    } catch (e) { checkAborted(signal); waterHow = 'none'; steps.push(`no water from the ice (${(e as Error).message}), so the plot is dry`) }
  }
  // torches (also keep the middle water open in the cold)
  if (plan.torches.length && canPlace(agent)) {
    if (countItem(bot, 'torch') < plan.torches.length) {
      if (!countItem(bot, 'stick')) await craftItem(bot, signal, 'stick', 4).catch(() => null)
      await craftItem(bot, signal, 'torch', 4).catch(() => null)
    }
    let lit = 0
    for (const [dx, dz] of plan.torches) {
      if (!countItem(bot, 'torch')) break
      if (dx === 0 && dz === 0 && waterHow !== 'none') continue
      try {
        const snow = bot.blockAt(at(dx, dz, 1))
        if (snow?.name === 'snow' || (snow && PLANT.test(snow.name))) await digBlock(bot, snow, signal)
        await placeAt(bot, 'torch', at(dx, dz, 1), signal); lit++
      } catch (e) { checkAborted(signal) }
    }
    if (lit) steps.push(`put up ${lit} torch${lit > 1 ? 'es' : ''}`)
  }
  // till and plant right away: dry farmland only stays farmland while something grows on it
  let planted = 0
  const seedsUsed: Record<string, number> = {}
  for (const [dx, dz] of plan.till) {
    checkAborted(signal)
    if (dx === 0 && dz === 0 && plan.centre !== 'crop') continue
    const seed = pickFarmSeed(inventory(bot))
    if (!seed) break
    const soil = at(dx, dz)
    try {
      if (!await tillAt(bot, soil, signal)) continue
      if (await plantOn(bot, soil, seed, signal).catch(() => false)) { planted++; seedsUsed[seed] = (seedsUsed[seed] ?? 0) + 1 }
    } catch (e) { checkAborted(signal) }
  }
  if (!planted) return fail(`could not till and plant the plot at ${fmtPos(c)}${steps.length ? ` (${steps.join(', ')})` : ''}`)
  const crop = Object.entries(seedsUsed).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'wheat_seeds'
  const cropName = ({ wheat_seeds: 'wheat', carrot: 'carrot', potato: 'potato', beetroot_seeds: 'beetroot' } as Record<string, string>)[crop] ?? crop
  let ids: string[] = []
  try { ids = siteBook(agent).all().filter(r => r.kind === 'farm').map(r => r.id) } catch {}
  const name = prev?.name ?? nextFarmName([...getFarms(agent).map(f => f.name), ...ids])
  const dim = bot.game?.dimension
  // site health judges only the cells that hold crops: a plot by a lake keeps its wet cells out;
  // an extended farm keeps its old land cells, moved to the new centre
  const oldLand = prev ? (prev.land ?? []).map(k => k.split(',').map(Number) as [number, number]).map(([dx, dz]) => `${prev.x + dx - c.x},${prev.z + dz - c.z}`) : []
  const land = [...new Set([...oldLand, ...plan.till.map(([dx, dz]) => `${dx},${dz}`), ...cells.filter(x => x.above === 'crop').map(x => `${x.dx},${x.dz}`)])]
    .filter(k => { const [dx, dz] = k.split(',').map(Number) as [number, number]; return Math.abs(dx) <= h && Math.abs(dz) <= h && !(dx === 0 && dz === 0 && waterHow !== 'none' && waterHow !== 'natural') })
  // water it made in the middle before is still its own (not a lake beside the plot)
  if (prev && (prev.water === 'ice' || prev.water === 'bucket') && prev.x === c.x && prev.z === c.z && bot.blockAt(at(0, 0))?.name === 'water') waterHow = prev.water
  const farm: Farm = {
    ...(prev ?? {}), name, x: c.x, y: c.y, z: c.z, ...(dim ? { dim } : {}), size: spot.size, crop: prev?.crop ?? cropName, created: prev?.created ?? Date.now(), tended: Date.now(), land, water: waterHow, kind: 'plot',
    ...(waterHow !== 'none' && plan.torches.length ? { keptOpen: 'torch' as const } : {})
  }
  if (waterHow === 'none') delete farm.keptOpen
  saveFarm(agent, farm)
  setPlace(agent, name, { x: c.x, y: c.y, z: c.z, ...(dim ? { dimension: dim } : {}) })
  try { agent.journal?.record(prev ? 'farm_extended' : 'farm_started', { name, size: spot.size, crop: cropName, planted, kind: 'plot', water: waterHow, waterFrom: choice.source }, { pos: farm }) } catch {}
  const head = prev ? `extended ${name} from ${prev.size}x${prev.size} to the ${spot.size}x${spot.size} farm plot at ${fmtPos(c)}` : `started ${name} on the ${spot.size}x${spot.size} farm plot at ${fmtPos(c)}`
  return ok(`${head}: planted ${planted} ${cropName}; ${plan.reason}; water: ${waterNote}${steps.length ? `; ${steps.join(', ')}` : ''}`, { farm })
}

const plotFarmAction = defineAction({
  name: 'plot_farm',
  description: 'Turn the farm plot its base keeps free inside the walls (base project farm_plot) into a farm, or extend its farm when the plot grew: ' +
    'water already in reach of the plot; on a plot of 5 and up a water bucket (carried, from a container, an empty one filled, or crafted from 3 iron) ' +
    'poured in the middle; ice it carries (only Silk Touch brings ice) broken in the middle; else a dry plot ' +
    '(crops on dry farmland still grow, about half as fast, as long as every tilled cell is planted). Short of seeds it takes them from its chests, ' +
    'then breaks grass near home. Torches give the crops light 9 and keep the middle water from freezing. ' +
    'Settings farming.plot, plotWater (auto | water | dry), plotSwap, plotSize, plotSeedRadius.',
  capabilities: ['move', 'dig', 'place'],
  params: z.object({
    spawnClearance: z.number().min(0).max(256).default(48).describe('never till within this distance of the world spawn')
  }),
  longRunning: true,
  run: (ctx, p) => plotFarm(ctx, p)
})

// ------------------------------------------------------------------ fish

/** Whether it has a fishing rod or can get one now: carried, in its chests, or made from string and sticks it carries or its chests hold. */
export function canGetRod (agent: Agent, bot: Bot): boolean {
  let stored: Record<string, number> = {}
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  return rodPlan({ inv: inventory(bot), stored, canCraft: !!agent.getAction('craft') }).step !== 'none'
}

/** Distance from the bot to water it could fish in near home (open, or lake ice to break a hole in), else null. */
export function fishWaterDistance (agent: Agent, bot: Bot, radius: number): number | null {
  const home = getHome(agent)
  const centre = home && sameDimension(bot, home) ? vec(bot, home.x, home.y, home.z) : bot.entity.position
  const spot = fishingWater(agent, bot, centre, radius, farmingOptions(agent).iceWater && !!agent.canDig)
  return spot ? Math.round(Math.hypot(spot.pos.x - bot.entity.position.x, spot.pos.z - bot.entity.position.z)) : null
}

/**
 * A fishing rod in the inventory: carried, taken from its chests, or crafted from 2 string and 3
 * sticks, taking the string, sticks or planks it lacks from its chests first (rodPlan).
 */
async function getRod (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal'>): Promise<string | null> {
  const { bot, agent, signal } = ctx
  if (findItem(bot, 'fishing_rod')) return ''
  let stored: Record<string, number> = {}
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  const plan = rodPlan({ inv: inventory(bot), stored, canCraft: !!agent.getAction('craft') })
  if (plan.step === 'withdraw') {
    await takeItemsFromOwnChests(ctx, plan.take).catch(() => null)
    if (findItem(bot, 'fishing_rod')) return 'took a fishing rod from a chest'
  }
  if (countItem(bot, 'string') < 2) return null
  if (countItem(bot, 'stick') < 3) {
    const planks = bot.inventory.items().find(i => itemName(i).endsWith('_planks'))
    if (!planks) {
      const log = bot.inventory.items().map(itemName).find(n => /_(log|stem)$/.test(n) && !n.startsWith('stripped_'))
      if (log) await craftItem(bot, signal, log.replace(/_(log|stem)$/, '_planks'), 4).catch(() => null)
    }
    await craftItem(bot, signal, 'stick', 4).catch(() => null)
  }
  const r = await craftItem(bot, signal, 'fishing_rod', 1).catch(e => ({ ok: false, message: (e as Error).message }))
  return findItem(bot, 'fishing_rod') ? 'made a fishing rod' : (r as { message?: string }).message ?? 'could not make a rod'
}

/** Open water to fish in near a point, else a shore ice block over water to break for a hole. */
function fishingWater (agent: Agent, bot: Bot, centre: Vec3, radius: number, iceOk: boolean): { pos: Vec3, ice: boolean } | null {
  const open = surfaceWater(bot, centre, radius, 32, true).find(w => !offLimits(agent, bot, w, 0))
  if (open) return { pos: open, ice: false }
  if (!iceOk) return null
  const ice = shoreIce(bot, centre, radius, 32).find(i => i.below === 'water' && /^(air|snow)$/.test(i.above) && !offLimits(agent, bot, i, 0))
  return ice ? { pos: vec(bot, ice.x, ice.y, ice.z), ice: true } : null
}

const FISH = ['cod', 'salmon', 'tropical_fish', 'pufferfish']

const fishAction = defineAction({
  name: 'fish',
  description: 'Fish for food: takes a rod from its chests or makes one from 2 string and 3 sticks (taking what it lacks from its chests) when it has none, goes to open water near home (or breaks a ' +
    'hole in a frozen lake, which turns back into water over the lake), and fishes until it has `count` catches or `maxMinutes` ' +
    'pass. Cod and salmon are cooked later by keep_fed.',
  capabilities: ['move'],
  params: z.object({
    count: z.number().int().min(1).max(32).default(6).describe('catches to stop at'),
    maxMinutes: z.number().min(1).max(30).default(5).describe('stop after this long'),
    radius: z.number().min(8).max(96).default(48).describe('how far from home to look for water')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const { bot, agent, signal, log } = ctx
    const notes: string[] = []
    const rod = await getRod(ctx)
    if (rod === null) return fail('no fishing rod and no 2 string to make one, carried or in its chests (spiders drop string)')
    if (!findItem(bot, 'fishing_rod')) return fail(`no fishing rod: ${rod}`)
    if (rod) notes.push(rod)
    const home = getHome(agent)
    const centre = home && sameDimension(bot, home) ? vec(bot, home.x, home.y, home.z) : bot.entity.position
    const fs = farmingOptions(agent)
    const spot = fishingWater(agent, bot, centre, p.radius, fs.iceWater && !!agent.canDig)
    if (!spot) return fail(`no open water within ${p.radius} blocks of home${fs.iceWater ? ' and no lake ice to break a hole in' : ''}`)
    try { await gotoWithin(bot, new goals.GoalNear(spot.pos.x, spot.pos.y + 1, spot.pos.z, 3), signal, 60_000) } catch (e) { checkAborted(signal) }
    if (spot.ice) {
      const b = bot.blockAt(spot.pos)
      if (b && ICE.test(b.name)) {
        await holdNoSilk(bot)
        try { await reachBlock(bot, spot.pos, signal, 4, 15_000); await digBlock(bot, b, signal) } catch (e) { checkAborted(signal) }
      }
      if (bot.blockAt(spot.pos)?.name !== 'water') return fail(`could not open a hole in the ice at ${fmtPos(spot.pos)}`)
      notes.push(`broke a hole in the ice at ${fmtPos(spot.pos)}`)
    }
    const before = FISH.reduce((n, f) => n + countItem(bot, f), 0)
    const t0 = Date.now()
    let casts = 0
    let fails = 0
    const caught = () => FISH.reduce((n, f) => n + countItem(bot, f), 0) - before
    while (caught() < p.count && Date.now() - t0 < p.maxMinutes * 60_000 && fails < 4) {
      checkAborted(signal)
      const r = findItem(bot, 'fishing_rod')
      if (!r) break
      await bot.equip(r, 'hand')
      await bot.lookAt(spot.pos.offset(0.5, 1, 0.5), true)
      casts++
      // a bite comes in 5 to 30 s (slower under a roof); reel in after 45 s and cast again
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 45_000) })
      const aborted = new Promise<'abort'>(resolve => signal.addEventListener('abort', () => resolve('abort'), { once: true }))
      const res = await Promise.race([bot.fish().then(() => 'bite' as const, () => 'cancel' as const), timeout, aborted])
      if (timer) clearTimeout(timer)
      if (res !== 'bite') { try { bot.activateItem() } catch {} }
      if (res === 'abort') checkAborted(signal)
      if (res === 'cancel') fails++
      await sleep(800, signal)
      await pickupNearby(bot, signal, { radius: 4, maxMs: 2000 }).catch(() => 0)
    }
    const n = caught()
    log.debug('fish', { casts, caught: n, fails })
    if (!n) return fail(`no catch in ${casts} casts at ${fmtPos(spot.pos)}${notes.length ? ` (${notes.join(', ')})` : ''}`)
    return ok(`caught ${n} fish in ${casts} casts at ${fmtPos(spot.pos)}${notes.length ? `; ${notes.join(', ')}` : ''}`, { caught: n })
  }
})

// ------------------------------------------------------------------ food_sources

const foodSourcesAction = defineAction({
  name: 'food_sources',
  description: 'Say which food source it relies on for the long run (a farm, the base plot, a bad farm to repair, animals, ' +
    'fishing, foraging), in the order settings food.sources gives, and why each one before it was skipped.',
  params: z.object({}),
  async run ({ bot, agent }) {
    cache.delete(agent)
    const c = foodSourceChoice(agent, bot)
    return ok(foodSourceText(c), c)
  }
})

export const foodSourceActions = [repairFarmAction, plotFarmAction, fishAction, foodSourcesAction]
export type { FoodSourceName }
