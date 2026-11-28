// Food self-sufficiency: scout for animals beyond the usual radius (find_food), start a
// small farm next to water (start_farm) and breed animals (breed). Food spots and farms are
// remembered in agent.storage (and as named places, so goto_place and farm_loop can use
// them). The planning parts are pure and live in foodPlan.ts.
import { enchantsOf } from './enchants.ts'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { Agent, ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, goals, travel, sleep, checkAborted, fmtPos, needsSurvival, itemName, TravelUnderwaterError, swimUp, activeTrip, rethrowTurnBack, TripTurnBackError } from '../core/index.ts'
import { huntRefusal, inPen, herdSurplus, unreachableAnimals, HUNTABLE, type HuntCandidate } from './combat.ts'
import { CROPS, isMature, plantOn, TILLABLE } from './farming.ts'
import { getHome, getPlaces, setPlace, sameDimension, reachDryLand, type Place } from './navigation.ts'
import { digBlock, DigRefusedError, findItem, countItem, placeAt, reachBlock, vec, within, gotoWithin, findPlaceFace, isReplaceable } from './world.ts'
import { pickupNearby, droppedItemName } from './pickup.ts'
import { climbOut, roofAbove } from './survival.ts'
import { ensureTool, equipFor } from './toolkit.ts'
import { collectBlocks } from './gather.ts'
import { craftItem, pickFuel } from './crafting.ts'
import { planFarmWork, farmWorkCount, oddSize, type FarmCell, type FarmGrid, type FarmWork } from './farmPlan.ts'
import { inDangerZone, wayThroughDanger } from './food-danger.ts'
import { takeItemsFromOwnChests, chestView, chestTotals } from './containers.ts'
import { nearBadSite, nextFarmName, FREEZE_TEMPERATURE } from './needPlan.ts'
import { planColdWater, waterFreezes, coverItem, sideCell, iceSourceOk, farmingSettings, type FarmingSettings, type IceCandidate } from './coldFarmPlan.ts'
import { siteBook } from '../core/sites.ts'
import { foodSourceActions, lastFoodSourceText } from './foodSources.ts'
import {
  seedStopReason, seedLimits, scoutWaypoints, scoutStopReason, nextWaypoint, sectorsText, compass, sectorOf, mergeSpot, markSpotEmpty, rankSpots, dryWaypoint,
  chooseFarmSite, siteProblems, plotLayout, pickFarmSeed, seedCount, breedPlan, BREED_FOOD, DEFAULT_SCOUT_LIMITS, ownWorkTest,
  type FoodSpot, type FoodSpotKind, type CellKind, type SiteCandidate, type Pos, type Waypoint
} from './foodPlan.ts'

// ------------------------------------------------------------------ memory

const SPOTS_KEY = 'foodSpots'
const FARMS_KEY = 'farms'

export interface Farm extends Pos {
  name: string
  dim?: string
  size: number
  crop: string
  created: number
  /** Last time it was harvested or checked (epoch ms). */
  tended?: number
  /** Cells ("dx,dz" from the water) that were land when it was made: site health judges only these. */
  land?: string[]
  /** Where its water came from: a lake or pond, ice it broke, a bucket, or none (a dry plot). */
  water?: 'natural' | 'ice' | 'bucket' | 'none'
  /** field: a farm by water it picked; plot: the base's reserved farm plot (plot_farm). Default field. */
  kind?: 'field' | 'plot'
  /** What keeps its water from freezing in a cold biome. */
  keptOpen?: 'cover' | 'torch'
}

/** agent.storage when there is one (unit-test fakes may have none). */
function store (agent: Agent): Agent['storage'] | null {
  return (agent as { storage?: Agent['storage'] }).storage ?? null
}

export function getFoodSpots (agent: Agent): FoodSpot[] {
  return store(agent)?.get<FoodSpot[]>(SPOTS_KEY, []) ?? []
}

const PLACE_FOR: Partial<Record<FoodSpotKind, string>> = { animals: 'food:animals', village_farm: 'food:village_farm', water: 'food:water' }

/** Remembers a food spot (storage, a named place for the best one of its kind, and the journal). */
export function rememberFoodSpot (agent: Agent, spot: FoodSpot): void {
  const st = store(agent)
  if (!st) return
  st.set(SPOTS_KEY, mergeSpot(getFoodSpots(agent), spot))
  const place = PLACE_FOR[spot.kind]
  if (place) setPlace(agent, place, { x: spot.x, y: spot.y, z: spot.z, ...(spot.dim ? { dimension: spot.dim } : {}) })
  try {
    agent.journal?.record('food_spot', { kind: spot.kind, count: spot.count, ...(spot.animals ? { animals: spot.animals } : {}) }, { pos: spot, ...(spot.dim ? { dim: spot.dim } : {}) })
  } catch {}
}

export function forgetEmptySpot (agent: Agent, kind: FoodSpotKind, at: { x: number, z: number }): void {
  const st = store(agent)
  if (!st) return
  const next = markSpotEmpty(getFoodSpots(agent), kind, at, Date.now())
  st.set(SPOTS_KEY, next)
  const place = PLACE_FOR[kind]
  if (place && !next.some(s => s.kind === kind)) setPlace(agent, place, null)
}

export function getFarms (agent: Agent): Farm[] {
  return store(agent)?.get<Farm[]>(FARMS_KEY, []) ?? []
}

export function saveFarm (agent: Agent, farm: Farm): void {
  const st = store(agent)
  if (!st) return
  st.set(FARMS_KEY, [...getFarms(agent).filter(f => f.name !== farm.name), farm])
}

/** The bot's farm nearest to `from` in this dimension, if any. */
export function nearestFarm (agent: Agent, bot: Bot, from: { x: number, z: number } = bot.entity.position): Farm | null {
  const dim = bot.game?.dimension
  return getFarms(agent)
    .filter(f => !f.dim || !dim || f.dim === dim)
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0] ?? null
}

/** True inside one of the bot's own farms (plot plus fence ring). */
export function inOwnFarm (agent: Agent, p: { x: number, z: number }): boolean {
  return getFarms(agent).some(f => Math.abs(p.x - f.x) <= (f.size - 1) / 2 + 2 && Math.abs(p.z - f.z) <= (f.size - 1) / 2 + 2)
}

// ------------------------------------------------------------------ sensing

export function spawnOf (bot: Bot): { x: number, z: number } | null {
  const s = (bot as { spawnPoint?: { x: number, z: number } }).spawnPoint
  return s && typeof s.x === 'number' ? s : null
}

/** Protected area, or within `clearance` of the world spawn (servers protect it; the zone file may not know yet). */
export function offLimits (agent: Agent, bot: Bot, p: { x: number, y?: number, z: number }, clearance = 48): boolean {
  const spawn = spawnOf(bot)
  if (spawn && clearance > 0 && Math.hypot(p.x - spawn.x, p.z - spawn.z) < clearance) return true
  return !!agent.protectedAreas?.isProtected({ x: p.x, y: p.y ?? bot.entity?.position.y ?? 64, z: p.z })
}

export interface AnimalCount {
  /** Adults the bot may hunt or breed, by name. */
  adults: Record<string, number>
  total: number
  entities: Entity[]
}

/**
 * Animals around a point that pass the hunt filter: listed passive adults only, never pets,
 * named, tamed or leashed ones, never in protected areas, and not inside fences unless the
 * fence is the bot's own farm (or `pens`).
 */
export function animalsAround (agent: Agent, bot: Bot, center: { x: number, y: number, z: number }, radius: number,
  animals: readonly string[] = HUNTABLE, opts: { pens?: boolean } = {}): AnimalCount {
  const adults: Record<string, number> = {}
  const entities: Entity[] = []
  // ones hunt just gave up on (out of reach) are not food for the next few minutes
  const gaveUp = unreachableAnimals(bot)
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || Math.hypot(e.position.x - center.x, e.position.y - center.y, e.position.z - center.z) > radius) continue
    if (gaveUp.has(e.id)) continue
    const keys = (bot.registry as any).entitiesByName?.[e.name ?? '']?.metadataKeys as string[] | undefined
    if (huntRefusal(e as HuntCandidate, { animals, metadataKeys: keys })) continue
    if (agent.protectedAreas?.isProtected(e.position)) continue
    if (!opts.pens && typeof bot.blockAt === 'function' && !inOwnFarm(agent, e.position) && inPen(bot, e)) continue
    adults[e.name!] = (adults[e.name!] ?? 0) + 1
    entities.push(e)
  }
  return { adults, total: entities.length, entities }
}

const cropIds = (bot: Bot) => Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
const ripeTest = (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age)

/** Ripe crops in one of the bot's own farms near the bot, with the farm. */
export function ownFarmRipe (agent: Agent, bot: Bot, maxDistance: number): { farm: Farm, ripe: number } | null {
  if (typeof bot.findBlocks !== 'function') return null
  for (const farm of getFarms(agent)) {
    if (Math.hypot(farm.x - bot.entity.position.x, farm.z - bot.entity.position.z) > maxDistance) continue
    const ripe = bot.findBlocks({ point: vec(bot, farm.x, farm.y + 1, farm.z), matching: cropIds(bot), maxDistance: (farm.size - 1) / 2 * 1.5 + 1, count: 81, useExtraInfo: ripeTest }).length
    if (ripe) return { farm, ripe }
  }
  return null
}

/** What is on one of its farms right now (only when the farm is loaded): ripe and growing crops, bare farmland. */
export function farmStatus (bot: Bot, farm: Farm): { ripe: number, growing: number, empty: number } | null {
  if (typeof bot.blockAt !== 'function') return null
  const h = (farm.size - 1) / 2
  let ripe = 0; let growing = 0; let empty = 0
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const soil = bot.blockAt(vec(bot, farm.x + dx, farm.y, farm.z + dz))
      if (!soil) return null
      if (soil.name !== 'farmland') continue
      const top = bot.blockAt(vec(bot, farm.x + dx, farm.y + 1, farm.z + dz))
      if (!top || top.name === 'air') { empty++; continue }
      if (CROPS[top.name]) { if (ripeTest(top)) ripe++; else growing++ }
    }
  }
  return { ripe, growing, empty }
}

/** The farm's square (target size) as planFarmWork sees it, or null when it isn't loaded. */
export function farmGrid (agent: Agent, bot: Bot, farm: Farm, targetSize: number, clearance = 48): FarmGrid | null {
  if (typeof bot.blockAt !== 'function') return null
  const h = (oddSize(Math.max(targetSize, 3)) - 1) / 2
  const cells: Record<string, FarmCell> = {}
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const x = farm.x + dx; const z = farm.z + dz
      const g = bot.blockAt(vec(bot, x, farm.y, z))
      if (!g) return null
      let kind: FarmCell = 'blocked'
      if (g.name === 'farmland') {
        const top = bot.blockAt(vec(bot, x, farm.y + 1, z))
        if (!top || top.name === 'air') kind = 'bare'
        else if (CROPS[top.name]) kind = ripeTest(top) ? 'ripe' : 'growing'
      } else {
        // the farm's own ground: its dirt counts, wherever the site check would have said 'farmland' around it
        const k = cellKind(agent, bot, x, farm.y, z, dx === 0 && dz === 0 ? 0 : clearance)
        kind = k === 'water' ? 'water' : k === 'tillable' ? 'dirt' : 'blocked'
      }
      cells[`${dx},${dz}`] = kind
    }
  }
  return { center: { x: farm.x, y: farm.y, z: farm.z }, cells }
}

/** What its farm needs, from what is carried. Null when the farm isn't loaded. */
export function farmWorkFor (agent: Agent, bot: Bot, farm: Farm, o: { targetSize: number, seedReserve: number, clearance?: number }): FarmWork | null {
  const grid = farmGrid(agent, bot, farm, o.targetSize, o.clearance)
  if (!grid) return null
  const inv = inventory(bot)
  const canTill = !!agent.canDig
  const canWater = canPlace(agent) && (!!inv.water_bucket || !!inv.bucket)
  // a plot farm never grows past its plot; its water (if any) is beside it, not in the middle, so every
  // cell counts as wet enough (crops keep dry farmland); only a plot with ice-made water in the middle has it there
  const plot = farm.kind === 'plot'
  return planFarmWork(grid, { targetSize: plot ? farm.size : o.targetSize, seeds: seedCount(inv), seedReserve: plot ? 0 : o.seedReserve, canTill, canWater: canWater && (!plot || farm.water === 'ice'), dry: plot ? farm.water !== 'ice' : farm.water === 'none' })
}

/** Ripe sweet berry bushes (age 2+) near a point, nearest first. */
export function ripeBerries (bot: Bot, center: Vec3, radius: number, count = 16): Vec3[] {
  const id = bot.registry.blocksByName.sweet_berry_bush?.id
  if (id === undefined || typeof bot.findBlocks !== 'function') return []
  return bot.findBlocks({ point: center, matching: id, maxDistance: radius, count, useExtraInfo: (b: Block) => Number((b.getProperties() as { age?: number | string }).age) >= 2 })
}

/** Natural (not player-placed) oak and dark oak leaves in reach of the ground near a point: apples drop from these. */
export function appleLeaves (bot: Bot, center: Vec3, radius = 6, count = 32): Vec3[] {
  const ids = ['oak_leaves', 'dark_oak_leaves'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  if (!ids.length || typeof bot.findBlocks !== 'function') return []
  return bot.findBlocks({
    point: center,
    matching: ids,
    maxDistance: radius,
    count,
    useExtraInfo: (b: Block) => String((b.getProperties() as { persistent?: unknown }).persistent) !== 'true' &&
      b.position.y >= center.y - 1 && b.position.y <= center.y + 4
  })
}

/**
 * Kelp it can cut from the shore without diving: per column, the lowest kelp block no more
 * than 2 below the water surface, with dry standing ground within 3 blocks. Cutting it breaks
 * the whole stalk above. Nearest first.
 */
export function shoreKelp (bot: Bot, center: Vec3, radius: number, count = 16): Vec3[] {
  const ids = ['kelp', 'kelp_plant'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  if (!ids.length || typeof bot.findBlocks !== 'function') return []
  const found = bot.findBlocks({ point: center, matching: ids, maxDistance: radius, count: count * 8 })
  const out: Vec3[] = []
  const seen = new Set<string>()
  for (const p of found) {
    const col = `${p.x},${p.z}`
    if (seen.has(col)) continue
    // find the surface above this column
    let top = p.y
    while (/kelp|water/.test(bot.blockAt(p.offset(0, top - p.y + 1, 0))?.name ?? '') && top - p.y < 24) top++
    if (bot.blockAt(p.offset(0, top - p.y + 1, 0))?.name !== 'air') continue
    const surface = top // the top water/kelp block
    const lowest = Math.max(surface - 2, p.y - 32)
    let y = lowest
    while (y <= surface && !/kelp/.test(bot.blockAt(p.offset(0, y - p.y, 0))?.name ?? '')) y++
    if (y > surface) continue
    seen.add(col)
    let shore = false
    for (let dx = -3; dx <= 3 && !shore; dx++) {
      for (let dz = -3; dz <= 3 && !shore; dz++) {
        for (const dy of [0, 1]) {
          const g = bot.blockAt(p.offset(dx, surface - p.y + dy, dz))
          const a = bot.blockAt(p.offset(dx, surface - p.y + dy + 1, dz))
          if (g && g.boundingBox === 'block' && !/water/.test(g.name) && a?.name === 'air') { shore = true; break }
        }
      }
    }
    if (shore) out.push(p.offset(0, y - p.y, 0))
    if (out.length >= count) break
  }
  return out
}

/**
 * Ripe crops of a village farm (a villager within 24 blocks) near a point, nearest first.
 * Fields without villagers are taken to be players' farms and left alone.
 */
export function villageCrops (bot: Bot, center: Vec3, radius: number): Vec3[] {
  if (typeof bot.findBlocks !== 'function') return []
  const villagers = Object.values(bot.entities ?? {}).filter(e => e?.name === 'villager' && e.position)
  if (!villagers.length) return []
  return bot.findBlocks({ point: center, matching: cropIds(bot), maxDistance: radius, count: 32, useExtraInfo: ripeTest })
    .filter(p => villagers.some(v => v.position.distanceTo(p) <= 24))
}

/**
 * Water source blocks with air above, near a point (nearest first). With `shore`, only water at
 * the edge (a land neighbour at the same height): the middle of a lake is never a farm site, and
 * a big lake would otherwise fill the whole result.
 */
export function surfaceWater (bot: Bot, center: Vec3, radius: number, count = 64, shore = false): Vec3[] {
  const water = bot.registry.blocksByName.water?.id
  if (water === undefined || typeof bot.findBlocks !== 'function') return []
  const edge = (p: Vec3) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const n = bot.blockAt(p.offset(dx!, 0, dz!))
    return !!n && n.name !== 'water' && n.boundingBox === 'block'
  })
  return bot.findBlocks({
    point: center,
    matching: water,
    maxDistance: radius,
    count,
    useExtraInfo: (b: Block) => Number((b.getProperties() as { level?: number | string }).level) === 0 &&
      bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' && (!shore || edge(b.position))
  })
}

/** Top block of a loaded column near height y, or null when not loaded. */
export function surfaceAt (bot: Bot, x: number, y: number, z: number): Block | null {
  for (let dy = 24; dy >= -32; dy--) {
    const b = bot.blockAt(vec(bot, x, y + dy, z))
    if (!b) return null
    if (b.boundingBox !== 'empty' || /water|lava/.test(b.name)) return b
  }
  return null
}

/** Height of the open-sky ground (first solid block or water from the top) at x/z, if loaded. */
export function topY (bot: Bot, x: number, z: number): number | null {
  const from = Math.min(319, Math.floor(bot.entity.position.y) + 96)
  for (let y = from; y > -64; y--) {
    const b = bot.blockAt(vec(bot, x, y, z))
    if (!b) return null
    if (b.name === 'water' || (b.boundingBox === 'block' && !b.name.endsWith('_leaves'))) return y + 1
  }
  return null
}

export const inventory = (bot: Bot): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const i of bot.inventory.items()) out[itemName(i)] = (out[itemName(i)] ?? 0) + i.count
  return out
}

/** Night, or a thunderstorm (mobs spawn): the same test stay_safe uses, so far trips and night retreat never disagree. */
export const isNight = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 0; return (bot as { thunderState?: number }).thunderState! > 0 || (t >= 12_542 && t <= 23_459) }

const here = (bot: Bot): Pos => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }

// ------------------------------------------------------------------ find_food

interface Sighting { kind: 'animals' | 'village_farm', at: Pos, count: number, animals?: string[], text: string }

function look (agent: Agent, bot: Bot, animals: readonly string[], crops: boolean, keepAtLeast = 0, radius = 64): Sighting | null {
  const pos = bot.entity.position
  const seen = animalsAround(agent, bot, pos, radius, animals)
  // a herd at its minimum is not food (keep_fed spares it)
  const spare = Object.values(herdSurplus(seen.adults, keepAtLeast)).reduce((a, b) => a + b, 0)
  if (seen.total && spare > 0) {
    // remember where the animals are, not where we stand
    const n = seen.entities.length
    const at = seen.entities.reduce((a, e) => ({ x: a.x + e.position.x / n, y: a.y + e.position.y / n, z: a.z + e.position.z / n }), { x: 0, y: 0, z: 0 })
    const tally = Object.entries(seen.adults).map(([k, v]) => `${v} ${k}`).join(', ')
    return { kind: 'animals', at: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }, count: seen.total, animals: Object.keys(seen.adults), text: tally }
  }
  if (crops) {
    const ripe = villageCrops(bot, pos, radius)
    if (ripe.length) return { kind: 'village_farm', at: { x: ripe[0]!.x, y: ripe[0]!.y, z: ripe[0]!.z }, count: ripe.length, text: `${ripe.length} ripe crops on a village farm` }
  }
  return null
}

function noteWater (agent: Agent, bot: Bot): void {
  const w = surfaceWater(bot, bot.entity.position, 32, 8)
  const p = w.find(v => !offLimits(agent, bot, v))
  if (p) rememberFoodSpot(agent, { kind: 'water', x: p.x, y: p.y, z: p.z, dim: bot.game?.dimension, seen: Date.now(), count: w.length })
}

const findFood = defineAction({
  name: 'find_food',
  description: 'Scout for food beyond what is in sight: first known food spots, then an expanding spiral around home (or here) ' +
    'out to `radius` blocks, by day, avoiding water, lava and protected areas, until it sees huntable animals or a village farm. ' +
    'Remembers what it finds as places (food:animals, food:village_farm, food:water). Does not hunt; use hunt or keep_fed after.',
  params: z.object({
    radius: z.number().min(32).max(1024).default(200).describe('how far from home to scout, in blocks'),
    atNight: z.boolean().default(false).describe('also scout at night (dangerous)'),
    animals: z.array(z.enum(HUNTABLE)).default([...HUNTABLE]).describe('animals that count as food'),
    crops: z.boolean().default(true).describe('village farms (crops with villagers nearby) count as food too'),
    maxMinutes: z.number().min(1).max(30).default(8).describe('give up after this long'),
    keepAtLeast: z.number().int().min(0).max(32).default(0).describe('only count animals above this many adults of a kind (a herd to spare)'),
    from: z.enum(['home', 'here']).default('home').describe('centre of the search: home (when set) or where the bot stands'),
    minRadius: z.number().min(0).max(1024).default(0).describe('skip rings at or inside this radius (an earlier, smaller search covered them)'),
    seeds: z.number().int().min(0).max(64).default(0).describe('pick up this many seeds on the way by breaking grass next to the path (for a farm later)')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const { bot, agent, signal, log } = ctx
    if (!needsSurvival(bot)) return fail(`no need to look for food in ${bot.game.gameMode} mode`)
    if (isNight(bot) && !p.atNight) return fail('it is night; I scout for food by day (atNight=true to go anyway)')
    const dim = bot.game?.dimension
    const home = getHome(agent)
    const center = p.from === 'home' && home && sameDimension(bot, home) ? home : here(bot)
    const centerName = center === home ? 'home' : 'here'
    const t0 = Date.now()
    const found = (s: Sighting, how: string): ActionResult => {
      rememberFoodSpot(agent, { kind: s.kind, x: s.at.x, y: s.at.y, z: s.at.z, dim, seen: Date.now(), count: s.count, ...(s.animals ? { animals: s.animals } : {}) })
      const d = Math.round(Math.hypot(s.at.x - center.x, s.at.z - center.z))
      const place = PLACE_FOR[s.kind]
      return ok(`${how}: ${s.text} at ${fmtPos(s.at)}, ${d} blocks ${compass(center, s.at)} of ${centerName} (remembered as ${place})`,
        { kind: s.kind, x: s.at.x, y: s.at.y, z: s.at.z, count: s.count })
    }
    const first = look(agent, bot, p.animals, p.crops, p.keepAtLeast)
    if (first) return found(first, 'food right here')

    // 1. known spots, best first
    const known = rankSpots(getFoodSpots(agent), p.crops ? ['animals', 'village_farm'] : ['animals'], Date.now(), center, dim)
      .filter(s => Math.hypot(s.x - center.x, s.z - center.z) <= p.radius * 1.5 && !inDangerZone(agent, s)).slice(0, 2)
    const checked: string[] = []
    for (const s of known) {
      checkAborted(signal)
      try {
        await travel(bot, { x: s.x, y: s.y, z: s.z }, signal, { range: 6 })
      } catch (e) {
        checkAborted(signal)
        rethrowTurnBack(e)
        log.debug('find_food: known spot unreachable', { at: fmtPos(s), error: (e as Error).message })
      }
      const seen = look(agent, bot, p.animals, p.crops, p.keepAtLeast)
      if (seen) return found(seen, `back at a known ${s.kind === 'animals' ? 'animal' : 'farm'} spot`)
      forgetEmptySpot(agent, s.kind, s)
      checked.push(`${s.kind.replace('_', ' ')} spot at ${fmtPos(s)} was empty`)
    }

    // 2. expanding spiral; start on the side away from the world spawn (busy, hunted out)
    const spawn = spawnOf(bot)
    const away = spawn && Math.hypot(center.x - spawn.x, center.z - spawn.z) > 4 ? Math.atan2(center.z - spawn.z, center.x - spawn.x) : Math.random() * Math.PI * 2
    // never towards a remembered danger zone: waypoints in one, or with the way out through one, are dropped
    let avoided = 0
    const wps: Waypoint[] = scoutWaypoints(center, p.radius, {
      startAngle: away,
      minRadius: p.minRadius,
      skip: (w) => {
        if (offLimits(agent, bot, w, 0)) return true
        if (inDangerZone(agent, w) || wayThroughDanger(agent, center, w)) { avoided++; return true }
        return false
      }
    })
    if (avoided) log.debug('find_food: skipped waypoints towards remembered danger zones', { avoided })
    const seedsAtStart = seedCount(inventory(bot))
    const visited = new Set<number>()
    const blocked = new Map<number, number>()
    const sectors: number[] = []
    let legs = 0
    let walked = 0
    let consecutiveFailures = 0
    let farthest = 0
    let reason: string | null = null
    const limits = { ...DEFAULT_SCOUT_LIMITS, atNight: p.atNight, maxMs: p.maxMinutes * 60_000, maxWalk: Math.max(600, p.radius * 12) }
    const progress = () => ({
      legs, walked, consecutiveFailures, elapsedMs: Date.now() - t0, night: isNight(bot), health: bot.health ?? 20,
      hostilesNear: Object.values(bot.entities).filter(e => e?.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 12).length
    })
    while (true) {
      checkAborted(signal)
      // a trip budget (skills/trip.ts) said turn back: food or daylight is short
      const turned = activeTrip(bot)
      if (turned?.turnBack && !turned.returning) { reason = `turned back: ${turned.turnBack}`; break }
      reason = scoutStopReason(progress(), limits)
      if (reason) break
      const i = nextWaypoint(wps, visited, blocked)
      if (i < 0) { reason = `covered every direction out to ${p.radius} blocks`; break }
      visited.add(i)
      let w = wps[i]!
      // don't aim at open water or lava when we can already see the spot: aim at dry ground near it instead
      const wetAt = (q: { x: number, z: number }) => surfaceAt(bot, q.x, Math.floor(bot.entity.position.y), q.z)
      let top = wetAt(w)
      if (top && /water|lava/.test(top.name)) {
        const alt = dryWaypoint(center, w, q => { const b = wetAt(q); return b ? /water|lava/.test(b.name) : null })
        if (!alt || offLimits(agent, bot, alt, 0)) { log.debug('find_food: skipping wet waypoint, no dry ground near it', { at: `${w.x} ${w.z}`, block: top.name }); continue }
        log.debug('find_food: wet waypoint, going to dry ground near it', { at: `${w.x} ${w.z}`, block: top.name, instead: `${alt.x} ${alt.z}` })
        w = { ...w, ...alt }
        top = wetAt(w)
      }
      const start = bot.entity.position.clone()
      // Aim at the open-sky ground (not just any solid block in a ±30 window, which can be a cave
      // floor or nothing at all on a mountain), so the pathfinder stays on the surface.
      const sky = topY(bot, w.x, w.z)
      let wentUnder = false
      // walk there, but stop as soon as something edible comes into view
      const ctl = new AbortController()
      const leg = AbortSignal.any([signal, ctl.signal])
      let seen: Sighting | null = null
      try {
        // with the surface height when we can see it, so the pathfinder doesn't tunnel there
        await travel(bot, sky !== null ? { x: w.x, y: sky, z: w.z } : top ? { x: w.x, y: top.position.y + 1, z: w.z } : { x: w.x, z: w.z }, leg, {
          range: 8,
          stepTimeoutMs: 45_000,
          // scouting for food: walking keeps the food bar (sprinting burns it ~10x faster), and lake beds drown
          walk: true,
          avoidWater: true,
          onProgress: () => {
            seen = look(agent, bot, p.animals, p.crops, p.keepAtLeast)
            // Dropped well below both where we started and the target ground, under a roof: we're in
            // a cave or ravine, not on the way. Stop and climb out (Pax died at y=-3 like this).
            const y = bot.entity.position.y
            if (y < Math.min(start.y, sky ?? start.y) - 10 && roofAbove(bot, 32) !== null) { wentUnder = true; ctl.abort() }
            if (seen || scoutStopReason(progress(), limits)) ctl.abort()
          }
        })
        consecutiveFailures = 0
      } catch (e) {
        checkAborted(signal)
        if (e instanceof TripTurnBackError) { reason = e.message; break }
        if (!ctl.signal.aborted) {
          consecutiveFailures++
          blocked.set(w.sector, w.ring + 1)
          log.debug('find_food: leg failed', { to: `${w.x} ${w.z}`, error: (e as Error).message })
          // Sank on a lake bed: the next leg from this spot dives into the same water (it did, twice,
          // and Pax drowned there once the action ended). Get to dry land and stop scouting.
          if (e instanceof TravelUnderwaterError) {
            await swimUp(bot, signal)
            const dry = await reachDryLand(bot, signal)
            reason = `${(e as Error).message}${dry ? '' : ' (and found no dry land close by)'}`
            break
          }
        }
      }
      if (wentUnder) {
        // That direction leads into a cave or ravine: mark it and get back to the sky before going on.
        blocked.set(w.sector, w.ring)
        consecutiveFailures++
        log.info('find_food: ended up underground, climbing out', { at: fmtPos(bot.entity.position) })
        const r = await (climbOut as any).run(ctx, { maxBlocks: 64 }).catch((e: Error) => ({ ok: false, message: e.message }))
        if (!r?.ok) { reason = `fell into a cave at ${fmtPos(bot.entity.position)} and couldn't climb out (${r?.message ?? 'unknown'})`; break }
      }
      legs++
      walked += bot.entity.position.distanceTo(start)
      sectors.push(sectorOf(center, bot.entity.position))
      farthest = Math.max(farthest, Math.round(Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z)))
      seen ??= look(agent, bot, p.animals, p.crops, p.keepAtLeast)
      noteWater(agent, bot)
      // seeds for a farm later: grass right by the path, a few at a time, never a detour
      if (!seen && p.seeds > 0 && agent.canDig && seedCount(inventory(bot)) - seedsAtStart < p.seeds) {
        const got = await breakPlantsFor(ctx, p.seeds - (seedCount(inventory(bot)) - seedsAtStart), 48, 20_000, 8, 12).catch(e => { checkAborted(signal); return { broken: 0, seeds: 0 } })
        if (got.broken) log.debug('find_food: broke grass for seeds on the way', { broken: got.broken, seeds: got.seeds })
      }
      if (seen) return found(seen, `scouted ${farthest} blocks ${sectorsText(sectors)} of ${centerName}`)
    }
    const water = rankSpots(getFoodSpots(agent), ['water'], Date.now(), bot.entity.position, dim)[0]
    const parts = [
      ...checked,
      legs ? `scouted ${farthest} blocks ${sectorsText(sectors)} of ${centerName}, no animals${p.crops ? ' or village crops' : ''}` : 'did not get to scout',
      `stopped: ${reason}`,
      ...(water ? [`saw water at ${fmtPos(water)}`] : []),
      ...(avoided ? [`kept away from a remembered danger zone (${avoided} waypoints)`] : []),
      ...(p.seeds && seedCount(inventory(bot)) > seedsAtStart ? [`picked up ${seedCount(inventory(bot)) - seedsAtStart} seeds`] : [])
    ]
    return fail(parts.join('; '), { farthest, legs, reason })
  }
})

// ------------------------------------------------------------------ start_farm

const PLANTS = /^(short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|lily_of_the_valley|dead_bush|sweet_berry_bush|snow)$/
/** Blocks players place: a plot near these is somebody's base or farm. */
const BUILD = /(_planks|cobblestone|stone_bricks|bricks|glass|_fence|_wall|door|torch|lantern|_bed$|chest|barrel|crafting_table|furnace|_slab|_stairs|wool|carpet|concrete|terracotta|rail|ladder|sign|hay_block|composter|bell|scaffolding|farmland)/
/** Near a plot these rule it out: lava burns, ice means the water freezes there. */
const HAZARD = /^(lava|ice|packed_ice|blue_ice|frosted_ice|powder_snow|magma_block|fire)$/
export const ICE = /^(ice|packed_ice|blue_ice|frosted_ice)$/
/** A one-block layer over the ground it may dig off to till under it: grass or dirt, or a snow block on snowy ground. */
const isBank = (name: string) => TILLABLE.includes(name) || name === 'snow_block'
const FENCES = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_fence$/

/** What a plot cell is (ground at y, the block above at y+1). */
export function cellKind (agent: Agent, bot: Bot, x: number, y: number, z: number, clearance: number, iceAsWater = false, own?: (p: Pos) => boolean): CellKind {
  if (offLimits(agent, bot, { x, y, z }, clearance)) return 'protected'
  const g = bot.blockAt(vec(bot, x, y, z))
  const a = bot.blockAt(vec(bot, x, y + 1, z))
  if (!g || !a) return 'other'
  if (g.name === 'water') return 'water'
  // a frozen shore: the lake side is water under the ice (it hydrates once one block is open)
  if (iceAsWater && ICE.test(g.name)) return 'water'
  if (g.name === 'farmland') return 'farmland'
  // its own blocks (a cover, a torch, its walls) are no crop ground, but nobody else's build either
  if (BUILD.test(g.name) || BUILD.test(a.name)) return own && (BUILD.test(g.name) ? own({ x, y, z }) : true) && (!BUILD.test(a.name) || own({ x, y: y + 1, z })) ? 'other' : 'build'
  if (TILLABLE.includes(g.name) && (a.name === 'air' || PLANTS.test(a.name))) return 'tillable'
  // a bank one block above the water: dig the top layer off and till the dirt under it
  // (farmland is only kept wet by water at its own height or one above)
  const a2 = bot.blockAt(vec(bot, x, y + 2, z))
  if (TILLABLE.includes(g.name) && isBank(a.name) && a2 && (a2.name === 'air' || PLANTS.test(a2.name))) return 'tillable'
  return 'other'
}

/** Farm sites marked bad (site health), with their size. */
function badFarmSites (agent: Agent): { x: number, z: number, size?: number }[] {
  try {
    return siteBook(agent).bad('farm').filter(r => r.pos).map(r => ({ x: r.pos!.x, z: r.pos!.z, size: typeof r.data?.size === 'number' ? r.data.size : 9 }))
  } catch { return [] }
}

function farmSiteIds (agent: Agent): string[] {
  try { return siteBook(agent).all().filter(r => r.kind === 'farm').map(r => r.id) } catch { return [] }
}

/** Water here freezes: a cold biome (snowy plains, frozen rivers, mountain tops). */
export function freezes (bot: Bot, p: { x: number, y: number, z: number }): boolean {
  const t = (bot.blockAt?.(vec(bot, p.x, p.y, p.z)) as { biome?: { temperature?: number } } | null)?.biome?.temperature
  return typeof t === 'number' && t < FREEZE_TEMPERATURE
}

/** A candidate plot around a water block: plot cells plus a 3-block ring checked for builds/fields. */
export function siteAt (agent: Agent, bot: Bot, water: Vec3, size: number, from: { x: number, z: number }, clearance: number, o: { iceAsWater?: boolean, own?: (p: Pos) => boolean } = {}): SiteCandidate {
  const h = (size - 1) / 2
  const own = o.own ?? ownWork(agent)
  const cells: Record<string, CellKind> = {}
  let buildNote: string | undefined
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const k = cellKind(agent, bot, water.x + dx, water.y, water.z + dz, clearance, !!o.iceAsWater, own)
      cells[`${dx},${dz}`] = k
      if (k === 'build' && !buildNote) {
        const b = [0, 1].map(dy => bot.blockAt(vec(bot, water.x + dx, water.y + dy, water.z + dz))).find(b => b && BUILD.test(b.name))
        if (b) buildNote = `${b.name} at ${fmtPos(b.position)}`
      }
    }
  }
  // crops need light: a cell under a roof (little sky light) stays dark at night and mobs spawn on it.
  // Only when the chunk has light data at all (some servers send none: everything reads 0).
  const sky: Record<string, number> = {}
  for (const k of Object.keys(cells)) {
    const [dx, dz] = k.split(',').map(Number)
    const up = bot.blockAt(vec(bot, water.x + dx!, water.y + 1, water.z + dz!))
    // a bank one above the water: the light that counts is on top of it
    const top = up && isBank(up.name) ? bot.blockAt(vec(bot, water.x + dx!, water.y + 2, water.z + dz!)) : up
    const l = (top as { skyLight?: number } | null)?.skyLight
    if (typeof l === 'number') sky[k] = l
  }
  if (Object.values(sky).some(l => l > 0)) for (const [k, l] of Object.entries(sky)) if (l < 10 && cells[k] === 'tillable') cells[k] = 'other'
  const around: CellKind[] = []
  const m = h + 3
  for (let dx = -m; dx <= m; dx++) {
    for (let dz = -m; dz <= m; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= h) continue
      if ((dx + dz) % 2) continue // every other block is plenty to spot a wall or a field
      for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(vec(bot, water.x + dx, water.y + dy, water.z + dz))
        if (b && BUILD.test(b.name)) {
          // its own torches, walls, covers and farms are not somebody else's
          if (own && own({ x: water.x + dx, y: water.y + dy, z: water.z + dz })) continue
          around.push(b.name === 'farmland' ? 'farmland' : 'build')
          if (b.name !== 'farmland' && !buildNote) buildNote = `${b.name} at ${fmtPos(b.position)}`
          break
        }
        if (b && HAZARD.test(b.name) && !(o.iceAsWater && ICE.test(b.name))) { around.push('hazard'); break }
      }
    }
  }
  return { water: { x: water.x, y: water.y, z: water.z }, cells, around, distance: Math.hypot(water.x - from.x, water.z - from.z), ...(buildNote ? { buildNote } : {}) }
}

/**
 * The bot's own work near farm sites (build.own, its torches, finished builds, its farms, its
 * base), or undefined with farming.ownBuilds off. Read straight from storage: lighting.ts and
 * construction.ts import this file.
 */
export function ownWork (agent: Agent): ((p: Pos) => boolean) | undefined {
  const st = store(agent)
  if (!st) return undefined
  const f = (agent.settings as { farming?: unknown } | undefined)?.farming
  const o = f && typeof f === 'object' ? f as Record<string, unknown> : {}
  if (f === false || o.ownBuilds === false) return undefined
  const radius = typeof o.ownBaseRadius === 'number' ? o.ownBaseRadius : 12
  const spots = st.get<{ anchor?: { origin?: Pos } } | undefined>('projects.spots', undefined)
  const origin = spots?.anchor?.origin
  let bad: { x: number, z: number, size?: number }[] = []
  try { bad = siteBook(agent).all().filter(r => r.kind === 'farm' && r.pos).map(r => ({ x: r.pos!.x, z: r.pos!.z, size: typeof r.data?.size === 'number' ? r.data.size : 9 })) } catch {}
  return ownWorkTest({
    blocks: st.get<string[] | undefined>('build.own', undefined) ?? [],
    torches: st.get<Pos[] | undefined>('lighting.torches', undefined) ?? [],
    boxes: (st.get<{ box?: { min: Pos, max: Pos } }[] | undefined>('build.placements', undefined) ?? []).flatMap(p => p.box ? [p.box] : []),
    farms: [...getFarms(agent), ...bad],
    base: origin && radius > 0 ? { x: origin.x, z: origin.z, radius } : null
  })
}

const GRASS = ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern']
const grassIds = (bot: Bot) => GRASS.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)

/** Seed grass more than this far above or below the bot is left alone (caves, cliffs). */
export const GRASS_Y_BAND = 12

/** Nothing solid above the grass for 24 blocks (leaves and the like let light through): it's at the surface. */
function openAbove (bot: Bot, p: { x: number, y: number, z: number }): boolean {
  const base = bot.blockAt(p as any)
  if (!base) return false
  for (let dy = 1; dy <= 24; dy++) {
    const b = bot.blockAt((base.position as any).offset(0, dy, 0))
    if (!b) return true // above the loaded world: open
    if (b.boundingBox === 'block' && !/leaves|glass|ice/.test(b.name)) return false
  }
  return true
}

/**
 * Grass it may break for seeds within `radius` of `center` (default: the bot), nearest first:
 * not protected, not near the world spawn, not in `skip`. Looks at many candidates, since the
 * nearest few dozen are often all inside a protected base.
 */
export function breakableGrass (agent: Agent, bot: Bot, radius: number, o: { clearance?: number, skip?: ReadonlySet<string>, center?: { x: number, z: number }, count?: number } = {}): Block[] {
  const ids = grassIds(bot)
  if (!ids.length) return []
  const center = o.center
  const out: Block[] = []
  const y0 = bot.entity.position.y
  for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 1024 })) {
    if (o.skip?.has(p.toString())) continue
    if (center && Math.hypot(p.x - center.x, p.z - center.z) > radius) continue
    // surface grass only: lush caves have grass too, and a seed run walked Pax 75 blocks down
    // into one (shot by skeletons at y -11)
    if (Math.abs(p.y - y0) > GRASS_Y_BAND || !openAbove(bot, p)) continue
    if (offLimits(agent, bot, p, o.clearance ?? 48)) continue
    const b = bot.blockAt(p)
    if (b) out.push(b)
    if (out.length >= (o.count ?? 1)) break
  }
  return out
}

export interface SeedRun {
  broken: number
  /** Seeds that ended up in the inventory. */
  seeds: number
  /** Seed drops seen next to broken grass, and how many of those it walked over. */
  dropped: number
  picked: number
  /** Why it stopped (seedStopReason). */
  stopped: string
  /** Breakable grass still in range when it stopped. */
  grassLeft: boolean
  ms: number
}

const isSeedItem = (name: string | null) => !!name && /^(wheat_seeds|beetroot_seeds|carrot|potato)$/.test(name)

/**
 * Walks over the drops lying next to a block it just broke (seeds pop out up to a block or two
 * away and are only picked up by walking onto them). Returns the seed drops it saw.
 */
async function collectDropsAt (bot: Bot, pos: Vec3, signal: AbortSignal, seen: Set<number>): Promise<number> {
  await sleep(350, signal) // the item entity and its metadata arrive a moment after the break
  let seeds = 0
  const near = () => Object.values(bot.entities).filter(e => e.name === 'item' && !seen.has(e.id) && e.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 3)
  for (const drop of near()) {
    seen.add(drop.id)
    if (isSeedItem(droppedItemName(drop))) seeds++
    if (!bot.entities[drop.id]) continue
    try {
      const p = drop.position
      await gotoWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0.5), signal, 5000)
      await sleep(200, signal)
    } catch (e) { checkAborted(signal) }
  }
  return seeds
}

/**
 * Breaks grass for seeds until it has `want` more, time runs out (maxMs), the breakable grass
 * within `maxDistance` of where it started runs out, or the break budget is used (seedStopReason).
 * The nearest grass goes first, so it works outwards patch by patch. Drops next to each broken
 * block are walked over right away, and once more at the end.
 */
export async function breakPlantsFor (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, want: number, clearance: number, maxMs = 4 * 60_000,
  maxDistance = 64, maxBroken?: number): Promise<SeedRun> {
  const { bot, agent, signal, log } = ctx
  const t0 = Date.now()
  const before = seedCount(inventory(bot))
  const start = { x: bot.entity.position.x, z: bot.entity.position.z }
  const limits = { ...seedLimits(want, maxMs), ...(maxBroken !== undefined ? { maxBroken } : {}) }
  const skip = new Set<string>()
  const seenDrops = new Set<number>()
  let broken = 0
  let dropped = 0
  let failsInRow = 0
  let stopped: string | null = null
  let next: Block | undefined
  const got = () => seedCount(inventory(bot)) - before
  while (true) {
    checkAborted(signal)
    next = breakableGrass(agent, bot, maxDistance, { clearance, skip, center: start })[0]
    stopped = seedStopReason({ got: got(), want, broken, elapsedMs: Date.now() - t0, grassLeft: !!next, failsInRow }, limits)
    if (stopped || !next) break
    const target = next
    try {
      await reachBlock(bot, target.position, signal, 2, 15_000)
      await digBlock(bot, target, signal)
      broken++
      failsInRow = 0
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) agent.markProtected(target.position, { crop: true })
      skip.add(target.position.toString())
      failsInRow++
      continue
    }
    skip.add(target.position.toString())
    dropped += await collectDropsAt(bot, target.position, signal, seenDrops).catch(e => { checkAborted(signal); return 0 })
  }
  // anything still lying around (a drop that rolled away, or arrived late)
  await pickupNearby(bot, signal, { radius: 8, maxMs: 10_000 }).catch(() => 0)
  const seeds = got()
  const grassLeft = !!breakableGrass(agent, bot, maxDistance, { clearance, skip, center: start })[0]
  const run: SeedRun = { broken, seeds, dropped, picked: Math.min(dropped, seeds), stopped: stopped ?? 'no more grass I may break in range', grassLeft, ms: Date.now() - t0 }
  log.debug('broke plants for seeds', { broken, seeds, dropped, stopped: run.stopped, grassLeft })
  return run
}

/** Gets a hoe: one in the inventory, crafted from what's there, or crafted after chopping a couple of logs. */
export async function getHoe (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, clearance = 48): Promise<ActionResult> {
  const { bot, signal } = ctx
  let r = await ensureTool(bot, signal, 'hoe')
  if (r.ok) return r
  const logs = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped')).map(b => b.id)
  const tree = bot.findBlocks({ matching: logs, maxDistance: 48, count: 32 }).map(p => bot.blockAt(p)).find(b => b && !offLimits(ctx.agent, bot, b.position, clearance))
  if (!tree) return fail(`${r.message}, and no tree I may chop within 48 blocks`)
  // walk to the tree first so collect picks this one, not a nearer one in a protected area
  try { await reachBlock(bot, tree.position, ctx.signal, 3, 30_000) } catch (e) { checkAborted(ctx.signal) }
  const got = await collectBlocks(ctx, tree.name, 3)
  if (!got.ok) return fail(`${r.message}; tried to get logs: ${got.message}`)
  r = await ensureTool(bot, signal, 'hoe')
  return r.ok ? ok(`${got.message}, ${r.message}`) : r
}

/** Puts water from a bucket into the block at `hole` (which must be air with a solid floor). */
export async function pourWater (bot: Bot, hole: Vec3, signal: AbortSignal): Promise<boolean> {
  const bucket = findItem(bot, 'water_bucket')
  if (!bucket) return false
  await reachBlock(bot, hole, signal)
  await bot.equip(bucket, 'hand')
  await bot.lookAt(hole.offset(0.5, 0.1, 0.5), true)
  bot.activateItem()
  await sleep(400, signal)
  return bot.blockAt(hole)?.name === 'water'
}

/** Fills an empty bucket from a water source. */
export async function fillBucket (bot: Bot, water: Vec3, signal: AbortSignal): Promise<boolean> {
  const bucket = findItem(bot, 'bucket')
  if (!bucket) return false
  await reachBlock(bot, water, signal)
  await bot.equip(bucket, 'hand')
  await bot.lookAt(water.offset(0.5, 0.9, 0.5), true)
  bot.activateItem()
  await sleep(400, signal)
  return !!findItem(bot, 'water_bucket')
}

/** Tills one ground block (breaking a plant on top first). */
export async function tillAt (bot: Bot, pos: Vec3, signal: AbortSignal): Promise<boolean> {
  // lower a one-block bank first: plant on top, then the grass/dirt itself
  const top = bot.blockAt(pos.offset(0, 2, 0))
  if (top && top.name !== 'air' && PLANTS.test(top.name) && isBank(bot.blockAt(pos.offset(0, 1, 0))?.name ?? '')) {
    await reachBlock(bot, top.position, signal, 2, 15_000)
    await digBlock(bot, top, signal)
  }
  const bank = bot.blockAt(pos.offset(0, 1, 0))
  if (bank && isBank(bank.name)) {
    await reachBlock(bot, bank.position, signal, 2, 15_000)
    await digBlock(bot, bank, signal)
  }
  const above = bot.blockAt(pos.offset(0, 1, 0))
  if (above && above.name !== 'air' && PLANTS.test(above.name)) {
    await reachBlock(bot, above.position, signal, 2, 15_000)
    await digBlock(bot, above, signal)
  }
  const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'))
  if (!hoe) return false
  const ground = bot.blockAt(pos)
  if (!ground || !TILLABLE.includes(ground.name) || bot.blockAt(pos.offset(0, 1, 0))?.name !== 'air') return ground?.name === 'farmland'
  await reachBlock(bot, pos, signal, 2, 15_000)
  if (!within(bot, pos)) return false
  await bot.equip(hoe, 'hand')
  await bot.activateBlock(ground, vec(bot, 0, 1, 0))
  await sleep(150, signal)
  return bot.blockAt(pos)?.name === 'farmland'
}

export const canPlace = (agent: Agent) => (agent.settings as { canPlace?: boolean } | undefined)?.canPlace !== false

// ------------------------------------------------------------------ water in the cold (coldFarmPlan.ts)

/** Ice at the surface near a point (open above, with land next to it at the same height), nearest first. */
export function shoreIce (bot: Bot, center: Vec3, radius: number, count = 96): IceCandidate[] {
  const ids = ['ice', 'packed_ice', 'blue_ice'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  if (!ids.length || typeof bot.findBlocks !== 'function') return []
  const land = (p: Vec3) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const n = bot.blockAt(p.offset(dx!, 0, dz!))
    return !!n && TILLABLE.includes(n.name)
  })
  const out: IceCandidate[] = []
  for (const p of bot.findBlocks({ point: center, matching: ids, maxDistance: radius, count: count * 4 })) {
    if (!land(p)) continue
    const above = bot.blockAt(p.offset(0, 1, 0))
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!above || !below) continue
    const sky = (above as { skyLight?: number }).skyLight
    out.push({ x: p.x, y: p.y, z: p.z, above: above.name, below: below.name, belowSolid: below.boundingBox === 'block', sky: typeof sky === 'number' ? sky : null })
    if (out.length >= count) break
  }
  return out
}

/**
 * A read-only look at the farm water around a point, for the survival bench's --survey: open
 * shore water (and how much of it freezes), shore ice, and what rules the best candidates out.
 */
export function farmWaterSurvey (agent: Agent, bot: Bot, center: Pos, radius = 96, size = 9): string {
  const c = vec(bot, center.x, center.y, center.z)
  const waters = surfaceWater(bot, c, radius, 160, true)
  const cold = waters.filter(w => freezes(bot, w)).length
  const wc = waters.map(w => siteAt(agent, bot, w, size, center, 48, { iceAsWater: freezes(bot, w) }))
  const raw = shoreIce(bot, c, radius)
  const ice = raw.filter(i => iceSourceOk(i, {}))
  const ic = ice.map(i => { const cand = siteAt(agent, bot, vec(bot, i.x, i.y, i.z), size, center, 48, { iceAsWater: true }); cand.cells['0,0'] = 'water'; return cand })
  const best = chooseFarmSite(ic)
  return `open shore water ${waters.length} (${cold} freezing; ${chooseFarmSite(wc) ? 'a usable site' : siteProblems(wc) || 'none'}), ` +
    `shore ice ${raw.length} (${ice.length} open with water or ground under; ${best ? `usable site at ${fmtPos(best.water)}` : siteProblems(ic) || 'none'})`
}

/** The cold-water settings (settings.farming). */
export function farmingOptions (agent: Agent): FarmingSettings {
  return farmingSettings((agent.settings as { farming?: unknown } | undefined)?.farming)
}

/** Torches it carries, or could make now from coal/charcoal and a stick or planks. */
export function torchesAvailable (bot: Bot): number {
  const t = countItem(bot, 'torch')
  if (t) return t
  const fuel = countItem(bot, 'coal') + countItem(bot, 'charcoal')
  const wood = countItem(bot, 'stick') + bot.inventory.items().filter(i => itemName(i).endsWith('_planks')).reduce((n, i) => n + i.count, 0)
  return fuel && wood ? 4 : 0
}

/** Holds a tool without Silk Touch (ice broken with it makes no water), or nothing. */
export async function holdNoSilk (bot: Bot): Promise<void> {
  const silk = (i: any) => enchantsOf(i).some(e => e.name === 'silk_touch')
  const pick = bot.inventory.items().find(i => itemName(i).endsWith('_pickaxe') && !silk(i))
  if (pick) { await bot.equip(pick, 'hand'); return }
  if (silk(bot.heldItem)) await bot.unequip('hand').catch(() => {})
}

/**
 * Gets a water source at the site's centre in the cold and keeps it from freezing
 * (planColdWater): breaks the ice when it is ice, then puts a cheap block over the water (with a
 * helper block on the shore cell next to it to place against, taken back after) or a torch on
 * that shore cell. Returns what it did, or why it couldn't.
 */
export async function keepWaterOpen (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, site: SiteCandidate, centre: 'ice' | 'water', fs: FarmingSettings): Promise<{ ok: boolean, how: 'none' | 'cover' | 'torch', message: string }> {
  const { bot, agent, signal, log } = ctx
  const w = vec(bot, site.water.x, site.water.y, site.water.z)
  const cold = freezes(bot, site.water) || centre === 'ice'
  const light = (bot.blockAt(w) as { light?: number } | null)?.light
  const covered = bot.blockAt(w.offset(0, 1, 0))?.boundingBox === 'block'
  const side = sideCell(site.cells as Record<string, string>)
  let stored: Record<string, number> | undefined
  try { stored = chestTotals(chestView(agent, bot)).has } catch {}
  const plan = planColdWater({
    centre,
    freezes: waterFreezes({ cold, covered, blockLight: typeof light === 'number' ? light : 0 }),
    mode: canPlace(agent) ? fs.protectWater : 'off',
    inv: inventory(bot),
    stored,
    torches: canPlace(agent) ? torchesAvailable(bot) : 0,
    side: !!side,
    iceWater: fs.iceWater,
    canDigBlocks: !!agent.canDig
  })
  if (!plan.ok) return { ok: false, how: 'none', message: plan.reason }
  const done: string[] = []
  const sidePos = side ? vec(bot, w.x + side[0], w.y + 1, w.z + side[1]) : null
  for (const step of plan.steps) {
    checkAborted(signal)
    if (step === 'take_blocks') {
      const item = coverItem(stored ?? {})
      if (!item) continue
      const r = await takeItemsFromOwnChests(ctx, { [item]: 2 }, 128, {}, chestView(agent, bot)).catch(e => { checkAborted(signal); return { took: {} as Record<string, number> } })
      if ((r.took[item] ?? 0) >= 2) done.push(`took 2 ${item} from my chests`)
    } else if (step === 'dig_blocks') {
      // two ground blocks from just outside the plot (grass drops dirt, stone cobblestone), never protected or built
      // logs it carries make planks (one log, four planks) faster and more surely than digging:
      // on a snowy stony shore no ground block at the water's height was diggable (bench: dug 0)
      const log = Object.keys(inventory(bot)).find(k => /_(log|stem)$/.test(k) && !k.startsWith('stripped_'))
      if (log) {
        const planks = log.replace(/_(log|stem)$/, '_planks')
        const r = await craftItem(bot, signal, planks, 2).catch(e => { checkAborted(signal); return null })
        if (r?.ok && coverItem(inventory(bot))) { done.push(`made ${planks} for a cover`); continue }
      }
      const h = (Math.sqrt(Object.keys(site.cells).length) - 1) / 2
      let got = 0
      for (let r = h + 2; r <= h + 4 && got < 2; r++) {
        for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, 1], [-r, 1], [1, r], [1, -r]] as const) {
          if (got >= 2 || coverItem(inventory(bot))) break
          const g = bot.blockAt(vec(bot, w.x + dx, w.y, w.z + dz))
          const up = bot.blockAt(vec(bot, w.x + dx, w.y + 1, w.z + dz))
          if (!g || !/^(grass_block|dirt|coarse_dirt|stone|andesite|diorite|granite)$/.test(g.name) || !up || !/^(air|snow|short_grass)$/.test(up.name)) continue
          if (offLimits(agent, bot, g.position, 0)) continue
          try { await reachBlock(bot, g.position, signal, 3, 15_000); await equipFor(bot, g).catch(() => {}); await digBlock(bot, g, signal); got++ } catch (e) { checkAborted(signal) }
        }
      }
      await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 }).catch(() => 0)
      if (!coverItem(inventory(bot))) return { ok: false, how: 'none', message: `could not dig two blocks to cover the water (dug ${got})` }
      done.push(`dug ${got} blocks beside the plot for a cover`)
    } else if (step === 'break_ice') {
      // from the shore cell, never standing on the ice it breaks
      if (sidePos) { try { await gotoWithin(bot, new goals.GoalBlock(sidePos.x, sidePos.y, sidePos.z), signal, 30_000) } catch (e) { checkAborted(signal) } }
      const ice = bot.blockAt(w)
      if (!ice || !ICE.test(ice.name)) return { ok: false, how: 'none', message: `the ice at ${fmtPos(w)} is gone (${ice?.name ?? 'not loaded'})` }
      await holdNoSilk(bot)
      // covered already: dig it through its shore-side face (the server checks reach, not sight)
      const covered = bot.blockAt(w.offset(0, 1, 0))?.boundingBox === 'block'
      const face = covered && side ? vec(bot, side[0], 0, side[1]) : undefined
      try { await reachBlock(bot, w, signal, 3, 15_000); await digBlock(bot, ice, signal, 400, face) } catch (e) {
        checkAborted(signal)
        return { ok: false, how: 'none', message: `could not break the ice at ${fmtPos(w)}: ${(e as Error).message}` }
      }
      if (bot.blockAt(w)?.name !== 'water') return { ok: false, how: 'none', message: `broke the ice at ${fmtPos(w)} but got ${bot.blockAt(w)?.name ?? 'nothing'}, not water` }
      done.push(`broke the ice at ${fmtPos(w)} for water`)
    } else if (step === 'cover' && sidePos) {
      const item = coverItem(inventory(bot))
      if (!item) return { ok: false, how: 'none', message: 'no blocks left to cover the water' }
      const over = w.offset(0, 1, 0)
      const errors: string[] = []
      const put = async (pos: Vec3): Promise<boolean> => {
        try {
          const snow = bot.blockAt(pos)
          if (snow && snow.name === 'snow') await digBlock(bot, snow, signal)
          await placeAt(bot, item, pos, signal)
          return true
        } catch (e) { checkAborted(signal); errors.push(`${fmtPos(pos)}: ${(e as Error).message}`); return false }
      }
      let helper: Vec3 | null = null
      // on ice the ice itself takes the block; over open water it needs a block next to it at that height
      if (!findPlaceFace(bot, over)) {
        const cands = [sidePos, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => over.offset(dx!, 0, dz!))]
        for (const c of cands) {
          if (c.equals(over) || !isReplaceable(bot.blockAt(c)?.name) || !findPlaceFace(bot, c)) continue
          if (offLimits(agent, bot, c, 0)) continue
          if (await put(c)) { helper = c; break }
        }
      }
      await put(over)
      if (helper && bot.blockAt(helper)?.name === item) {
        try { await reachBlock(bot, helper, signal, 3, 15_000); await digBlock(bot, bot.blockAt(helper)!, signal) } catch (e) { checkAborted(signal) }
        await pickupNearby(bot, signal, { radius: 4, maxMs: 4000 }).catch(() => 0)
      }
      if (bot.blockAt(over)?.boundingBox !== 'block') return { ok: false, how: 'none', message: `could not put a block over the water at ${fmtPos(w)}${errors.length ? ` (${errors.slice(-2).join('; ')})` : ''}` }
      done.push(`covered ${fmtPos(w)} with ${item} so it doesn't freeze`)
    } else if (step === 'torch' && sidePos) {
      if (!countItem(bot, 'torch')) {
        if (!countItem(bot, 'stick')) await craftItem(bot, signal, 'stick', 4).catch(() => null)
        await craftItem(bot, signal, 'torch', 4).catch(() => null)
      }
      try {
        const snow = bot.blockAt(sidePos)
        if (snow && snow.name === 'snow') await digBlock(bot, snow, signal)
        await placeAt(bot, 'torch', sidePos, signal)
      } catch (e) {
        checkAborted(signal)
        return { ok: false, how: 'none', message: `could not put a torch by the water: ${(e as Error).message}` }
      }
      site.cells[`${side![0]},${side![1]}`] = 'other' // the torch stands there: not tilled
      done.push(`put a torch next to it so it doesn't freeze`)
    }
  }
  return { ok: true, how: plan.protection.how, message: done.join(', ') || plan.reason }
}

export interface StartFarmParams {
  place?: string
  x?: number
  z?: number
  size: number
  radius: number
  seeds: number
  fence: boolean
  light: boolean
  spawnClearance: number
}

/** The start_farm body, for reuse. */
export async function startFarm (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, p: StartFarmParams): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  if (!agent.canDig) return fail('I need digging enabled to till a farm')
  const dim = bot.game?.dimension
  if (dim && !/overworld/.test(dim)) return fail(`crops need the overworld, I'm in ${dim}`)
  const steps: string[] = []

  // where the farm should be
  let center: Place | null = null
  let centerName = 'here'
  if (p.place) {
    const pl = getPlaces(agent)[p.place.toLowerCase()] ?? (p.place.toLowerCase() === 'home' ? getHome(agent) : undefined)
    if (!pl) return fail(`don't know a place called ${p.place}`)
    center = pl; centerName = p.place
  } else if (p.x !== undefined && p.z !== undefined) {
    let y = topY(bot, p.x, p.z)
    if (y === null) {
      // not loaded yet: walk over first, then read the ground height
      try { await travel(bot, { x: p.x, z: p.z }, signal, { range: 6 }) } catch (e) { checkAborted(signal) }
      y = topY(bot, p.x, p.z)
    }
    center = { x: p.x, y: y ?? Math.floor(bot.entity.position.y), z: p.z }; centerName = `${p.x} ${p.z}`
  } else {
    const home = getHome(agent)
    if (home && sameDimension(bot, home)) { center = home; centerName = 'home' }
  }
  center ??= here(bot)
  if (Math.hypot(center.x - bot.entity.position.x, center.z - bot.entity.position.z) > p.radius) {
    try { await travel(bot, { x: center.x, y: center.y, z: center.z }, signal, { range: 6 }) } catch (e) { checkAborted(signal); return fail(`couldn't get to ${centerName}: ${(e as Error).message}`) }
  }

  // the site first (cheap, and no point collecting seeds without one): natural water first, then a remembered water spot, then water we bring
  const size = Math.max(3, Math.min(9, p.size % 2 ? p.size : p.size - 1))
  // farms that went bad (flooded, frozen, unreachable: site health) and their surroundings are left alone
  const badFarms = badFarmSites(agent)
  // cold ground (coldFarmPlan.ts): water that would freeze is fine when it can be kept open
  const fs = farmingOptions(agent)
  const coldOk = fs.protectWater !== 'off' && canPlace(agent)
  let source: 'natural' | 'ice' | 'bucket' = 'natural'
  let iceKept: 'cover' | 'torch' | undefined
  let iceNote: string | null = null
  const pick = (from: { x: number, y: number, z: number }) => {
    // within the radius first, then as far as the loaded chunks go
    for (const r of [...new Set([p.radius, Math.max(p.radius, 96)])]) {
      const waters = surfaceWater(bot, vec(bot, from.x, from.y, from.z), r, 160, true)
        .filter(w => !nearBadSite(w, badFarms) && (coldOk || !freezes(bot, w)))
      // water it keeps open may have ice around it (that is the lake freezing, not a hazard)
      const best = chooseFarmSite(waters.map(w => siteAt(agent, bot, w, size, center!, p.spawnClearance, { iceAsWater: coldOk && freezes(bot, w) })))
      if (best) return best
    }
    return null
  }
  // search around the centre at its height (findBlocks is a sphere: from a tunnel the surface is out of range)
  let site = pick({ x: bot.entity.position.x, y: center.y, z: bot.entity.position.z })
  if (!site) {
    const remembered = rankSpots(getFoodSpots(agent), ['water'], Date.now(), center, dim)
      .find(s => Math.hypot(s.x - center!.x, s.z - center!.z) <= Math.max(128, p.radius * 2) && !offLimits(agent, bot, s, p.spawnClearance))
    if (remembered) {
      try {
        await travel(bot, { x: remembered.x, y: remembered.y + 1, z: remembered.z }, signal, { range: 6 })
        site = pick(remembered)
        if (site) steps.push(`went to water I saw earlier at ${fmtPos(remembered)}`)
      } catch (e) { checkAborted(signal) }
    }
  }
  if (!site && fs.iceWater && agent.canDig) {
    // a frozen shore or pond: break the ice over water (or ground) for a source, keep it open
    const nether = !!dim && /nether/.test(dim)
    for (const r of [...new Set([p.radius, Math.max(p.radius, 96)])]) {
      const raw = shoreIce(bot, vec(bot, center.x, center.y, center.z), r)
      const ice = raw
        .filter(c => iceSourceOk(c, { nether }) && !nearBadSite(c, badFarms) && !offLimits(agent, bot, c, p.spawnClearance))
      const cands = ice.map(c => {
        const cand = siteAt(agent, bot, vec(bot, c.x, c.y, c.z), size, center!, p.spawnClearance, { iceAsWater: true })
        cand.cells['0,0'] = 'water'
        return cand
      })
      const best = chooseFarmSite(cands)
      if (!best) {
        if (r === Math.max(p.radius, 96)) iceNote = (!raw.length ? 'no ice next to tillable ground' : ice.length ? `${ice.length} shore ice blocks, none usable (${siteProblems(cands)})` : `${raw.length} shore ice blocks, none open above with water or ground under, away from the bad farm`)
        continue
      }
      const r2 = await keepWaterOpen(ctx, best, 'ice', fs)
      if (r2.ok) { site = best; source = 'ice'; if (r2.how !== 'none') iceKept = r2.how; steps.push(r2.message); break }
      iceNote = `at ${fmtPos(best.water)}, ${r2.message}`
      break
    }
  }
  if (!site && canPlace(agent)) {
    // carry water: fill a bucket if we only have an empty one
    if (!findItem(bot, 'water_bucket') && findItem(bot, 'bucket')) {
      const src = surfaceWater(bot, bot.entity.position, 64, 8)[0]
      if (src && await fillBucket(bot, src, signal).catch(() => false)) steps.push(`filled a bucket at ${fmtPos(src)}`)
    }
    if (findItem(bot, 'water_bucket')) {
      // dig a hole in flat grass and pour the water in
      const grass = bot.findBlocks({ point: vec(bot, center.x, center.y, center.z), matching: ['grass_block', 'dirt'].map(n => bot.registry.blocksByName[n]!.id), maxDistance: Math.min(32, p.radius), count: 96 })
      const cands = grass.filter(g => !nearBadSite(g, badFarms) && (coldOk || !freezes(bot, g))).map(g => {
        const c = siteAt(agent, bot, g, size, center!, p.spawnClearance)
        c.cells['0,0'] = 'water'
        return c
      })
      const dry = chooseFarmSite(cands, { minTillable: 60 }) // carried water: only on really flat ground
      if (dry) {
        const hole = vec(bot, dry.water.x, dry.water.y, dry.water.z)
        try {
          const b = bot.blockAt(hole)
          if (b) { await reachBlock(bot, hole, signal); await digBlock(bot, b, signal) }
          if (await pourWater(bot, hole, signal)) { site = dry; source = 'bucket'; steps.push(`made a water hole at ${fmtPos(hole)}`) }
        } catch (e) {
          checkAborted(signal)
          log.debug('start_farm: could not make water', { error: (e as Error).message })
        }
      }
    }
  }
  if (!site) return fail(`no flat grass next to water within ${Math.max(p.radius, 96)} blocks of ${centerName} that isn't protected or somebody's build, and no water bucket; ${fs.iceWater ? `frozen shore: ${iceNote ?? 'none found'}` : 'farming.iceWater is off'}${steps.length ? ` (${steps.join(', ')})` : ''}`)
  // open water (a lake or a poured hole) in a cold biome: keep it from freezing too
  let keptOpen: 'cover' | 'torch' | undefined
  if (source === 'ice') keptOpen = iceKept
  else if (freezes(bot, site.water)) {
    const k = await keepWaterOpen(ctx, site, 'water', fs)
    if (!k.ok) return fail(`the water at ${fmtPos(site.water)} would freeze: ${k.message}`)
    if (k.how !== 'none') keptOpen = k.how
    steps.push(k.message)
  }

  // seeds (the walk may take us away from the site; tilling walks back cell by cell): its chests first
  let inv = inventory(bot)
  if (seedCount(inv) < p.seeds) {
    const got = await seedsFromChests(ctx, 'wheat_seeds', p.seeds - seedCount(inv)).catch(e => { checkAborted(signal); return { took: 0 } })
    if (got.took) steps.push(`took ${got.took} wheat_seeds from my chests`)
    inv = inventory(bot)
  }
  if (seedCount(inv) < p.seeds) {
    const got = await breakPlantsFor(ctx, p.seeds - seedCount(inv), p.spawnClearance)
    inv = inventory(bot)
    if (got.broken) steps.push(`broke ${got.broken} grass for ${got.seeds} seeds`)
  }
  if (!pickFarmSeed(inv)) return fail(`found a site at ${fmtPos(site.water)} but no seeds to plant: ${steps.length ? steps.join(', ') : 'no grass to break within 64 blocks'} (wheat seeds come from breaking grass)`)

  // a hoe
  const hoe = await getHoe(ctx, p.spawnClearance)
  if (!hoe.ok) return fail(`no hoe: ${hoe.message}`)
  if ((hoe.data as { crafted?: boolean } | undefined)?.crafted || /crafted/.test(hoe.message)) steps.push(hoe.message)

  // till, nearest to the water first, then plant
  const layout = plotLayout(site.water, size)
  const water = vec(bot, site.water.x, site.water.y, site.water.z)
  try { await gotoWithin(bot, new goals.GoalNear(water.x, water.y + 1, water.z, 3), signal, 45_000) } catch (e) { checkAborted(signal) }
  let tilled = 0
  let refused = 0
  // only as many cells as it has seeds for (bare farmland dries back to dirt); tend_farm grows the rest later
  const tillMax = Math.max(4, seedCount(inventory(bot)))
  for (const c of layout.till) {
    checkAborted(signal)
    if (tilled >= tillMax) break
    if (site.cells[`${c.x - site.water.x},${c.z - site.water.z}`] !== 'tillable') continue
    try {
      if (await tillAt(bot, vec(bot, c.x, c.y, c.z), signal)) tilled++
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) { agent.markProtected(c, { crop: true }); if (++refused >= 2) break }
    }
  }
  if (!tilled) return fail(`could not till anything at ${fmtPos(site.water)}${refused ? ' (the server refused: protected?)' : ''}`)
  let planted = 0
  const seedsUsed: Record<string, number> = {}
  for (const c of layout.till) {
    checkAborted(signal)
    const soil = vec(bot, c.x, c.y, c.z)
    if (bot.blockAt(soil)?.name !== 'farmland' || bot.blockAt(soil.offset(0, 1, 0))?.name !== 'air') continue
    const seed = pickFarmSeed(inventory(bot))
    if (!seed) break
    if (await plantOn(bot, soil, seed, signal).catch(() => false)) { planted++; seedsUsed[seed] = (seedsUsed[seed] ?? 0) + 1 }
  }
  const crop = Object.entries(seedsUsed).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'wheat_seeds'
  const cropName = ({ wheat_seeds: 'wheat', carrot: 'carrot', potato: 'potato', beetroot_seeds: 'beetroot' } as Record<string, string>)[crop] ?? crop

  // optional fence and torches, only from what we have (or can craft from planks in hand)
  if (p.fence && canPlace(agent)) {
    const fenceItem = () => bot.inventory.items().map(itemName).find(n => FENCES.test(n))
    const have = () => bot.inventory.items().filter(i => FENCES.test(itemName(i))).reduce((n, i) => n + i.count, 0)
    const planks = bot.inventory.items().filter(i => itemName(i).endsWith('_planks')).reduce((n, i) => n + i.count, 0)
    if (have() < layout.fence.length && planks >= Math.ceil((layout.fence.length - have()) / 3) * 5) {
      const kind = bot.inventory.items().map(itemName).find(n => n.endsWith('_planks'))!.replace('_planks', '_fence')
      // 4 planks + 2 sticks make 3 fences; craftItem doesn't make the sticks itself
      const sticks = Math.ceil((layout.fence.length - have()) / 3) * 2
      if (countItem(bot, 'stick') < sticks) await craftItem(bot, signal, 'stick', sticks - countItem(bot, 'stick')).catch(() => null)
      await craftItem(bot, signal, kind, layout.fence.length - have()).catch(() => null)
    }
    if (have() >= layout.fence.length) {
      let placed = 0
      for (const f of layout.fence) {
        checkAborted(signal)
        const it = fenceItem()
        if (!it) break
        try { await placeAt(bot, it, vec(bot, f.x, f.y, f.z), signal); placed++ } catch (e) { checkAborted(signal) }
      }
      if (placed) steps.push(`fenced it (${placed} fences, gap at ${fmtPos(layout.gap)})`)
    }
  }
  if (p.light && canPlace(agent)) {
    if (countItem(bot, 'torch') < 4 && countItem(bot, 'coal') + countItem(bot, 'charcoal') > 0) {
      if (!countItem(bot, 'stick')) await craftItem(bot, signal, 'stick', 4).catch(() => null)
      await craftItem(bot, signal, 'torch', 4).catch(() => null)
    }
    let lit = 0
    for (const t of layout.torches) {
      if (!countItem(bot, 'torch')) break
      // on a fence post when there is one, else on the ground at the corner
      const onPost = FENCES.test(bot.blockAt(vec(bot, t.x, t.y - 1, t.z))?.name ?? '')
      const at = onPost ? t : { x: t.x, y: t.y - 1, z: t.z }
      try { await placeAt(bot, 'torch', vec(bot, at.x, at.y, at.z), signal); lit++ } catch (e) { checkAborted(signal) }
    }
    if (lit) steps.push(`put up ${lit} torches`)
  }

  // remember it
  // never a name a bad farm still has (its site record is re-checked under that name)
  const name = nextFarmName([...getFarms(agent).map(f => f.name), ...farmSiteIds(agent)])
  const land = Object.entries(site.cells).filter(([k, v]) => k !== '0,0' && v === 'tillable').map(([k]) => k)
  const farm: Farm = { name, x: site.water.x, y: site.water.y, z: site.water.z, dim, size, crop: cropName, created: Date.now(), tended: Date.now(), land, water: source, ...(keptOpen ? { keptOpen } : {}) }
  saveFarm(agent, farm)
  setPlace(agent, name, { x: farm.x, y: farm.y, z: farm.z, ...(dim ? { dimension: dim } : {}) })
  try { agent.journal?.record('farm_started', { name, size, crop: cropName, tilled, planted }, { pos: farm }) } catch {}
  const where = centerName === 'here' ? '' : `, ${Math.round(site.distance)} blocks from ${centerName}`
  return ok(`started a ${size}x${size} ${cropName} farm at ${fmtPos(site.water)}${where} (${name}): tilled ${tilled}, planted ${planted}` +
    `${steps.length ? `; ${steps.join(', ')}` : ''}`, { farm })
}

const startFarmAction = defineAction({
  name: 'start_farm',
  description: 'Start a small farm of its own: picks grass or dirt by water near home (or a place), outside protected areas ' +
    'and away from anybody\'s builds or fields (or pours water from a bucket), then gets seeds by breaking grass (or uses carrots, ' +
    'potatoes, beetroot seeds), makes a hoe if needed, tills a plot around the water, plants it, fences and lights it if it has the ' +
    'materials, and remembers it as farm:1, farm:2... for farm_loop/farm_setup. Needs digging enabled.',
  params: z.object({
    place: z.string().optional().describe('remembered place (or home) to farm near; default home, else here'),
    x: z.number().optional().describe('farm near this x (with z) instead'),
    z: z.number().optional(),
    size: z.number().int().min(3).max(9).default(9).describe('plot side, odd, around one water block (9 = 80 farmland)'),
    radius: z.number().min(8).max(96).default(48).describe('how far from the centre to look for water'),
    seeds: z.number().int().min(1).max(64).default(10).describe('seeds to collect before planting (breaks grass until it has them or gives up)'),
    fence: z.boolean().default(true).describe('fence the plot when it has (or can craft) enough fences'),
    light: z.boolean().default(true).describe('put torches on the corners when it has torches or coal'),
    spawnClearance: z.number().min(0).max(256).default(48).describe('never farm within this distance of the world spawn')
  }),
  longRunning: true,
  run: (ctx, p) => startFarm(ctx, p)
})

// ------------------------------------------------------------------ tend_farm

/** The seed for a farm: its own crop's seed when carried, else what there is most of. */
const FARM_SEED: Record<string, string> = { wheat: 'wheat_seeds', carrot: 'carrot', potato: 'potato', beetroot: 'beetroot_seeds' }

function seedForFarm (bot: Bot, farm: Farm): string | null {
  const inv = inventory(bot)
  const own = FARM_SEED[farm.crop]
  return own && (inv[own] ?? 0) > 0 ? own : pickFarmSeed(inv)
}

const tendFarm = defineAction({
  name: 'tend_farm',
  description: 'Look after its own farm (farm:1, farm:2...): put the water back if it is gone (with a bucket), plant bare farmland, ' +
    'till trampled dirt again and plant it, and grow the plot a ring at a time towards `size` around its water with the seeds ' +
    'it has, keeping `seedReserve` seeds for replanting; short of seeds it takes them from its own and configured chests near home first. Use harvest for ripe crops. Needs digging enabled for tilling.',
  params: z.object({
    farm: z.string().optional().describe('which farm (farm:1...); default the nearest'),
    size: z.number().int().min(3).max(9).default(9).describe('side of the square to grow the farm towards (one water block keeps 9x9 wet)'),
    seedReserve: z.number().int().min(0).max(32).default(4).describe('seeds kept for replanting: new cells only from seeds beyond these'),
    maxCells: z.number().int().min(1).max(80).default(40).describe('cells to plant or till at most this run'),
    fromChests: z.boolean().default(true).describe('short of seeds: take them from its own and configured chests near home first'),
    spawnClearance: z.number().min(0).max(256).default(48).describe('never till within this distance of the world spawn')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const { bot, agent, signal, log } = ctx
    const farm = p.farm ? getFarms(agent).find(f => f.name === p.farm!.toLowerCase()) : nearestFarm(agent, bot)
    if (!farm) return fail(p.farm ? `I have no farm called ${p.farm}` : 'I have no farm of my own (start_farm makes one)')
    // short of seeds for the farm: its chests near home first (the walk to the farm passes home anyway)
    let fromChest = ''
    if (p.fromChests) {
      const pre = farmWorkFor(agent, bot, farm, { targetSize: p.size, seedReserve: p.seedReserve, clearance: p.spawnClearance })
      const seed = FARM_SEED[farm.crop] ?? 'wheat_seeds'
      const want = pre ? pre.seedsWanted : Math.max(0, p.seedReserve * 2 - seedCount(inventory(bot)))
      if (want > 0) {
        const got = await seedsFromChests(ctx, seed, want)
        if (got.took) fromChest = `took ${got.took} ${seed} from my chest`
      }
    }
    if (Math.hypot(farm.x - bot.entity.position.x, farm.z - bot.entity.position.z) > 8) {
      try { await travel(bot, { x: farm.x, y: farm.y + 1, z: farm.z }, signal, { range: 4 }) } catch (e) { checkAborted(signal); return fail(`couldn't get to ${farm.name}: ${(e as Error).message}`) }
    }
    const work = farmWorkFor(agent, bot, farm, { targetSize: p.size, seedReserve: p.seedReserve, clearance: p.spawnClearance })
    if (!work) return fail(`${farm.name} isn't loaded`)
    log.debug('tend_farm: plan', { farm: farm.name, size: work.size, target: work.target, plant: work.plant.length, retill: work.retill.length, extend: work.extend.length, water: !!work.water, reason: work.reason })
    if (!farmWorkCount(work)) return fail(`${farm.name} (${work.size}x${work.size}, ${work.farmland} farmland): ${work.reason}`)
    const done: string[] = fromChest ? [fromChest] : []

    if (work.water) {
      const hole = vec(bot, work.water.x, work.water.y, work.water.z)
      try {
        if (!findItem(bot, 'water_bucket')) {
          const src = surfaceWater(bot, bot.entity.position, 48, 8).find(w => !w.equals(hole))
          if (src) await fillBucket(bot, src, signal)
        }
        const b = bot.blockAt(hole)
        if (b && b.name !== 'air' && b.name !== 'water' && TILLABLE.includes(b.name)) await digBlock(bot, b, signal)
        if (await pourWater(bot, hole, signal)) done.push('put the water back')
      } catch (e) { checkAborted(signal); log.debug('tend_farm: water failed', { error: (e as Error).message }) }
    }

    let cells = 0
    let planted = 0
    for (const c of work.plant) {
      if (cells >= p.maxCells) break
      checkAborted(signal)
      const seed = seedForFarm(bot, farm)
      if (!seed) break
      cells++
      if (await plantOn(bot, vec(bot, c.x, c.y, c.z), seed, signal).catch(() => false)) planted++
    }
    if (planted) done.push(`planted ${planted} bare farmland`)

    const tillAndPlant = async (list: Pos[]): Promise<number> => {
      let n = 0
      let refused = 0
      for (const c of list) {
        if (cells >= p.maxCells) break
        checkAborted(signal)
        const seed = seedForFarm(bot, farm)
        if (!seed) break
        cells++
        try {
          const soil = vec(bot, c.x, c.y, c.z)
          if (!await tillAt(bot, soil, signal)) continue
          if (await plantOn(bot, soil, seed, signal).catch(() => false)) n++
        } catch (e) {
          checkAborted(signal)
          if (e instanceof DigRefusedError) { agent.markProtected(c, { crop: true }); if (++refused >= 2) break }
        }
      }
      return n
    }
    if (work.retill.length || work.extend.length) {
      const hoe = agent.canDig ? await getHoe(ctx, p.spawnClearance) : fail('digging is off')
      if (!hoe.ok) done.push(`no hoe for tilling (${hoe.message})`)
      else {
        const re = await tillAndPlant(work.retill)
        if (re) done.push(`re-tilled and planted ${re}`)
        const grown = await tillAndPlant(work.extend)
        if (grown) done.push(`grew it by ${grown}`)
      }
    }
    const after = farmWorkFor(agent, bot, farm, { targetSize: p.size, seedReserve: p.seedReserve, clearance: p.spawnClearance })
    const size = Math.max(farm.size, after?.size ?? work.size)
    saveFarm(agent, { ...farm, size, tended: Date.now() })
    const state = after ? `now ${after.size}x${after.size} with ${after.farmland} farmland, ${seedCount(inventory(bot))} seeds left` : ''
    const changed = done.filter(t => !t.startsWith('no hoe') && !t.startsWith('took '))
    if (!changed.length) return fail(`${farm.name}: ${done.join(', ') || `could not do any of: ${work.reason}`}`)
    return ok(`${farm.name}: ${done.join(', ')}${state ? `; ${state}` : ''}`, { planted, size: after?.size, farmland: after?.farmland })
  }
})

// ------------------------------------------------------------------ gather_seeds, forage

/**
 * Seeds out of its own and configured chests near home (settings.storage.chests and the ones it
 * placed), up to `want`, only when a chest near home is known to hold some or was never looked
 * into. Returns how many it took.
 */
export async function seedsFromChests (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, seed: string, want: number): Promise<{ took: number, note?: string }> {
  if (want <= 0) return { took: 0 }
  const view = chestView(ctx.agent, ctx.bot)
  const t = chestTotals(view)
  if (!(t.has[seed] ?? 0) && !t.unknown) return { took: 0 }
  const r = await takeItemsFromOwnChests(ctx, { [seed]: want }, 128, {}, view).catch(e => { checkAborted(ctx.signal); return { took: {} as Record<string, number>, units: 0, notes: [(e as Error).message] } })
  if (r.notes.length) ctx.log.debug('seeds from chests', { notes: r.notes })
  return { took: r.took[seed] ?? 0, ...(r.notes.length ? { note: r.notes.join('; ') } : {}) }
}

const gatherSeeds = defineAction({
  name: 'gather_seeds',
  description: 'Get seeds for a farm by breaking surface grass and ferns nearby (open to the sky and near its own height, never cave grass; wheat seeds drop about 1 in 8) and picking them up. ' +
    'Keeps going, patch by patch out to the radius, until it has the seeds, the time is up or the grass runs out. ' +
    'Skips protected areas and the world spawn. First takes wheat seeds from its own and configured chests near home (fromChests). Needs digging enabled for the grass.',
  params: z.object({
    count: z.number().int().min(1).max(64).default(10).describe('seeds to get'),
    fromChests: z.boolean().default(true).describe('take seeds from its own and configured chests near home before breaking grass'),
    radius: z.number().min(4).max(128).default(32).describe('how far to look for grass'),
    maxMinutes: z.number().min(0.5).max(10).default(3).describe('give up after this long'),
    spawnClearance: z.number().min(0).max(256).default(48).describe('never break grass this close to the world spawn')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const before = seedCount(inventory(ctx.bot))
    const chest = p.fromChests ? await seedsFromChests(ctx, 'wheat_seeds', p.count) : null
    const fromChest = chest?.took ? `took ${chest.took} wheat seeds from my chest` : ''
    const short = p.count - (seedCount(inventory(ctx.bot)) - before)
    if (short <= 0) return ok(`${fromChest} (have ${seedCount(inventory(ctx.bot))})`, { seeds: chest?.took ?? 0, total: seedCount(inventory(ctx.bot)), fromChests: chest?.took ?? 0, broken: 0, grassLeft: true })
    if (!ctx.agent.canDig) return chest?.took ? ok(`${fromChest}; I need digging enabled to break grass for the rest`, { fromChests: chest.took }) : fail('I need digging enabled to break grass')
    const got = await breakPlantsFor(ctx, short, p.spawnClearance, p.maxMinutes * 60_000, p.radius)
    if (chest?.took && !got.broken) return ok(`${fromChest}; no grass I may break for the rest (have ${seedCount(inventory(ctx.bot))})`, { fromChests: chest.took, total: seedCount(inventory(ctx.bot)), grassLeft: false })
    const total = seedCount(inventory(ctx.bot))
    const data = { seeds: got.seeds, total, broken: got.broken, dropped: got.dropped, grassLeft: got.grassLeft, stopped: got.stopped }
    if (!got.broken) return fail(`no grass I may break within ${p.radius} blocks (have ${total} seeds)`, data)
    const drops = got.dropped === got.seeds ? '' : `, ${got.dropped} seed drop${got.dropped === 1 ? '' : 's'} seen`
    const text = `${fromChest ? `${fromChest}, ` : ''}broke ${got.broken} grass in ${Math.round(got.ms / 1000)}s for ${got.seeds} of ${short} seeds${drops} (have ${total}); stopped: ${got.stopped}`
    return got.seeds > 0 || chest?.took ? ok(text, { ...data, fromChests: chest?.took ?? 0 }) : fail(text, data)
  }
})

const FORAGE_KINDS = ['berries', 'kelp', 'apples'] as const

/** Whether kelp is worth cutting: it can be smelted into dried kelp (a furnace near, carried or craftable, and fuel). */
export function canSmeltKelp (bot: Bot): boolean {
  const names = bot.inventory.items().map(i => itemName(i))
  const has = (n: string) => countItem(bot, n)
  const furnace = !!bot.registry.blocksByName.furnace && (!!bot.findBlock?.({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 }) ||
    has('furnace') > 0 || has('cobblestone') + has('cobbled_deepslate') + has('blackstone') >= 8)
  return furnace && !!pickFuel(names, 'kelp')
}

const forage = defineAction({
  name: 'forage',
  description: 'Stopgap food from what grows wild nearby: pick ripe sweet berries (the bush stays), cut kelp at the shore without ' +
    'diving (smelt it into dried kelp later), and with apples=true break oak and dark oak leaves for apples (about 1 in 200) and ' +
    'pick up apples lying around. Never on protected land.',
  params: z.object({
    radius: z.number().min(4).max(64).default(32).describe('how far to look'),
    max: z.number().int().min(1).max(32).default(8).describe('bushes or kelp stalks to take at most'),
    kinds: z.array(z.enum(FORAGE_KINDS)).default(['berries', 'kelp']).describe('what to forage'),
    apples: z.boolean().default(false).describe('also break leaves for apples (slow, low odds: a last resort)'),
    leaves: z.number().int().min(1).max(64).default(24).describe('leaves to break at most for apples')
  }),
  longRunning: true,
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const kinds = new Set<string>([...p.kinds, ...(p.apples ? ['apples'] : [])])
    const before = { sweet_berries: countItem(bot, 'sweet_berries'), kelp: countItem(bot, 'kelp'), apple: countItem(bot, 'apple') }
    const notes: string[] = []
    let taken = 0
    const skip = new Set<string>()
    if (kinds.has('berries')) {
      for (let i = 0; i < p.max * 2 && taken < p.max; i++) {
        checkAborted(signal)
        const at = ripeBerries(bot, bot.entity.position, p.radius).find(v => !skip.has(v.toString()) && !offLimits(agent, bot, v, 0))
        if (!at) break
        skip.add(at.toString())
        try {
          await reachBlock(bot, at, signal, 3, 20_000)
          const b = bot.blockAt(at)
          if (!b || b.name !== 'sweet_berry_bush') continue
          await bot.activateBlock(b)
          await sleep(300, signal)
          taken++
        } catch (e) {
          checkAborted(signal)
          log.debug('forage: could not pick', { at: fmtPos(at), error: (e as Error).message })
        }
      }
      if (taken) await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 }).catch(() => 0)
    }
    if (kinds.has('kelp') && agent.canDig && taken < p.max) {
      let cut = 0
      for (let i = 0; i < p.max * 2 && taken < p.max; i++) {
        checkAborted(signal)
        const at = shoreKelp(bot, bot.entity.position, p.radius).find(v => !skip.has(v.toString()) && !offLimits(agent, bot, v, 0))
        if (!at) break
        skip.add(at.toString())
        try {
          await reachBlock(bot, at, signal, 4, 20_000)
          const b = bot.blockAt(at)
          if (!b || !/kelp/.test(b.name)) continue
          await digBlock(bot, b, signal)
          cut++; taken++
          await pickupNearby(bot, signal, { radius: 5, item: 'kelp', maxMs: 5000 }).catch(() => 0)
        } catch (e) {
          checkAborted(signal)
          if (e instanceof DigRefusedError) agent.markProtected(at, { crop: true })
          log.debug('forage: could not cut kelp', { at: fmtPos(at), error: (e as Error).message })
        }
      }
      if (cut && !canSmeltKelp(bot)) notes.push('no furnace or fuel to dry the kelp yet')
    }
    if (kinds.has('apples')) {
      await pickupNearby(bot, signal, { radius: Math.min(16, p.radius), item: 'apple', maxMs: 8000 }).catch(() => 0)
      if (agent.canDig) {
        let broken = 0
        for (let i = 0; i < p.leaves * 2 && broken < p.leaves; i++) {
          checkAborted(signal)
          const at = appleLeaves(bot, bot.entity.position, 6).find(v => !skip.has(v.toString()) && !offLimits(agent, bot, v, 0))
          if (!at) {
            // walk to the next tree with oak leaves within the radius
            const next = appleLeaves(bot, bot.entity.position, Math.min(24, p.radius)).find(v => !skip.has(v.toString()) && !offLimits(agent, bot, v, 0))
            if (!next) break
            skip.add(next.toString())
            try { await reachBlock(bot, next, signal, 4, 20_000) } catch (e) { checkAborted(signal) }
            continue
          }
          skip.add(at.toString())
          try {
            const b = bot.blockAt(at)
            if (!b || !/_leaves$/.test(b.name)) continue
            await reachBlock(bot, at, signal, 4, 10_000)
            await digBlock(bot, b, signal, 50)
            broken++
          } catch (e) {
            checkAborted(signal)
            if (e instanceof DigRefusedError) { agent.markProtected(at); break }
          }
        }
        if (broken) {
          await pickupNearby(bot, signal, { radius: 8, item: 'apple', maxMs: 8000 }).catch(() => 0)
          notes.push(`broke ${broken} leaves`)
        }
      }
    }
    const got = Object.entries(before).map(([n, b]) => [n, countItem(bot, n) - b] as const).filter(([, d]) => d > 0)
    const text = got.map(([n, d]) => `${d} ${n === 'sweet_berries' ? 'sweet berries' : n === 'apple' ? (d === 1 ? 'apple' : 'apples') : n}`).join(', ')
    const extra = notes.length ? ` (${notes.join(', ')})` : ''
    return got.length ? ok(`foraged ${text}${extra}`, Object.fromEntries(got)) : fail(`nothing foraged within ${p.radius} blocks (${[...kinds].join(', ')})${extra}`)
  }
})

// ------------------------------------------------------------------ breed

/** When we last fed each animal (entity id -> ms); breeding has a 5 minute cooldown. */
const fedAt = new WeakMap<object, Map<number, number>>()
const BREED_COOLDOWN_MS = 5.5 * 60_000

const breed = defineAction({
  name: 'breed',
  description: 'Breed two adult animals of a kind it sees (cows/sheep with wheat, pigs with carrots/potatoes/beetroot, ' +
    'chickens with seeds), leading them towards its farm first when it has one nearby. Never feeds pets, named, leashed ' +
    'or fenced animals that are not on its own farm. Keeps seeds for replanting.',
  params: z.object({
    animal: z.enum(Object.keys(BREED_FOOD) as [string, ...string[]]).optional().describe('which kind; default the best one it has food for'),
    radius: z.number().min(4).max(48).default(24).describe('how far to look for animals'),
    lure: z.boolean().default(true).describe('lead them to its farm first (when one is within 64 blocks)'),
    keepSeeds: z.number().int().min(0).max(64).default(8).describe('seeds to keep for replanting'),
    maxHerd: z.number().int().min(2).max(64).default(12).describe('do not breed a kind with this many adults around')
  }),
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const fed = fedAt.get(agent) ?? new Map<number, number>()
    fedAt.set(agent, fed)
    const now = Date.now()
    const kinds = p.animal ? [p.animal] : Object.keys(BREED_FOOD)
    const seen = animalsAround(agent, bot, bot.entity.position, p.radius, kinds)
    const ready = seen.entities.filter(e => now - (fed.get(e.id) ?? 0) > BREED_COOLDOWN_MS)
    const adults: Record<string, number> = {}
    for (const e of ready) adults[e.name!] = (adults[e.name!] ?? 0) + 1
    const plan = breedPlan(adults, inventory(bot), { animals: kinds, keepSeeds: p.keepSeeds, maxHerd: p.maxHerd })
    if (!plan) {
      const tally = Object.entries(seen.adults).map(([k, v]) => `${v} ${k}`).join(', ') || 'no animals'
      return fail(`nothing to breed: ${tally} within ${p.radius} blocks${p.animal ? '' : ''}, and food for two of a kind with 2+ ready adults is needed`)
    }
    const pair = ready.filter(e => e.name === plan.animal)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)).slice(0, 2)
    const food = () => findItem(bot, plan.food)
    let note = ''
    // lead them to the farm while holding the food (animals follow a player holding their food)
    const farm = nearestFarm(agent, bot)
    if (p.lure && farm && Math.hypot(farm.x - bot.entity.position.x, farm.z - bot.entity.position.z) < 64) {
      const dest = { x: farm.x, z: farm.z + (farm.size - 1) / 2 + 3 } // just outside the fence gap
      const until = Date.now() + 60_000
      await bot.equip(food()!, 'hand').catch(() => {})
      while (Date.now() < until) {
        checkAborted(signal)
        const pos = bot.entity.position
        const left = Math.hypot(dest.x - pos.x, dest.z - pos.z)
        if (left < 3) { note = ` near ${farm.name}`; break }
        if (pair.some(e => (e as any).isValid === false || e.position.distanceTo(pos) > 12)) { note = ' (they stopped following, bred them where they were)'; break }
        if (pair.some(e => e.position.distanceTo(pos) > 5)) { await sleep(1500, signal); continue }
        const k = Math.min(5, left) / left
        try { await gotoWithin(bot, new goals.GoalNearXZ(pos.x + (dest.x - pos.x) * k, pos.z + (dest.z - pos.z) * k, 1), signal, 8000) } catch (e) { checkAborted(signal) }
      }
    }
    const babies = () => Object.values(bot.entities).filter(e => e?.name === plan.animal && huntRefusal(e as HuntCandidate, { animals: [plan.animal], metadataKeys: (bot.registry as any).entitiesByName?.[plan.animal]?.metadataKeys }) === 'baby').length
    const before = babies()
    let fedCount = 0
    for (const e of pair) {
      checkAborted(signal)
      const it = food()
      if (!it || (e as any).isValid === false) break
      try {
        await gotoWithin(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), signal, 15_000)
        await bot.equip(it, 'hand')
        await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true)
        const n = countItem(bot, plan.food)
        await bot.activateEntity(e)
        await sleep(400, signal)
        if (countItem(bot, plan.food) < n) { fedCount++; fed.set(e.id, Date.now()) }
      } catch (err) {
        checkAborted(signal)
        log.debug('breed: could not feed', { animal: e.name, error: (err as Error).message })
      }
    }
    if (fedCount < 2) return fail(`fed ${fedCount} of 2 ${plan.animal}s with ${plan.food}${note}; no breeding`)
    // a baby shows up a few seconds later
    for (let i = 0; i < 8 && babies() <= before; i++) await sleep(1000, signal)
    const born = babies() > before
    return ok(`fed 2 ${plan.animal}s with ${plan.food}${note}${born ? ', a baby was born' : ', no baby yet'}`, { animal: plan.animal, food: plan.food, born })
  }
})

export const food = () => defineSkill({
  name: 'food',
  capabilities: ['move', 'eat'],
  description: 'Food self-sufficiency: scouting for animals and village farms, starting, tending and growing a farm of its own, gathering seeds, foraging berries, kelp and apples, breeding animals.',
  actions: [findFood, startFarmAction, tendFarm, gatherSeeds, forage, breed, ...foodSourceActions],
  observe: (agent) => {
    const farms = getFarms(agent).map(f => `${f.name} ${f.kind === 'plot' ? 'plot ' : ''}${f.crop} at ${fmtPos(f)}`)
    const spots = getFoodSpots(agent).filter(s => s.kind !== 'water').length
    const source = lastFoodSourceText(agent)
    return farms.length || spots || source ? { farms, foodSpots: spots, ...(source ? { foodSource: source } : {}) } : {}
  }
})
