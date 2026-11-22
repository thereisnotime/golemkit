// Food self-sufficiency: scout for animals beyond the usual radius (find_food), start a
// small farm next to water (start_farm) and breed animals (breed). Food spots and farms are
// remembered in agent.storage (and as named places, so goto_place and farm_loop can use
// them). The planning parts are pure and live in foodPlan.ts.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { Agent, ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, goals, travel, sleep, checkAborted, fmtPos, needsSurvival, itemName, TravelUnderwaterError } from '../core/index.ts'
import { huntRefusal, inPen, herdSurplus, HUNTABLE, type HuntCandidate } from './combat.ts'
import { CROPS, isMature, plantOn, TILLABLE } from './farming.ts'
import { getHome, getPlaces, setPlace, sameDimension, reachDryLand, type Place } from './navigation.ts'
import { digBlock, DigRefusedError, findItem, countItem, placeAt, reachBlock, vec, within, gotoWithin } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { climbOut, roofAbove } from './survival.ts'
import { ensureTool } from './toolkit.ts'
import { collectBlocks } from './gather.ts'
import { craftItem } from './crafting.ts'
import {
  scoutWaypoints, scoutStopReason, nextWaypoint, sectorsText, compass, sectorOf, mergeSpot, markSpotEmpty, rankSpots,
  chooseFarmSite, plotLayout, pickFarmSeed, seedCount, breedPlan, BREED_FOOD, DEFAULT_SCOUT_LIMITS,
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
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || Math.hypot(e.position.x - center.x, e.position.y - center.y, e.position.z - center.z) > radius) continue
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

const inventory = (bot: Bot): Record<string, number> => {
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
    radius: z.number().min(32).max(512).default(200).describe('how far from home to scout, in blocks'),
    atNight: z.boolean().default(false).describe('also scout at night (dangerous)'),
    animals: z.array(z.enum(HUNTABLE)).default([...HUNTABLE]).describe('animals that count as food'),
    crops: z.boolean().default(true).describe('village farms (crops with villagers nearby) count as food too'),
    maxMinutes: z.number().min(1).max(30).default(8).describe('give up after this long'),
    keepAtLeast: z.number().int().min(0).max(32).default(0).describe('only count animals above this many adults of a kind (a herd to spare)'),
    from: z.enum(['home', 'here']).default('home').describe('centre of the search: home (when set) or where the bot stands')
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
      .filter(s => Math.hypot(s.x - center.x, s.z - center.z) <= p.radius * 1.5).slice(0, 2)
    const checked: string[] = []
    for (const s of known) {
      checkAborted(signal)
      try {
        await travel(bot, { x: s.x, y: s.y, z: s.z }, signal, { range: 6 })
      } catch (e) {
        checkAborted(signal)
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
    const wps: Waypoint[] = scoutWaypoints(center, p.radius, { startAngle: away, skip: (w) => offLimits(agent, bot, w, 0) })
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
      reason = scoutStopReason(progress(), limits)
      if (reason) break
      const i = nextWaypoint(wps, visited, blocked)
      if (i < 0) { reason = `covered every direction out to ${p.radius} blocks`; break }
      visited.add(i)
      const w = wps[i]!
      // don't aim at open water or lava when we can already see the spot
      const top = surfaceAt(bot, w.x, Math.floor(bot.entity.position.y), w.z)
      if (top && /water|lava/.test(top.name)) { log.debug('find_food: skipping wet waypoint', { at: `${w.x} ${w.z}`, block: top.name }); continue }
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
        if (!ctl.signal.aborted) {
          consecutiveFailures++
          blocked.set(w.sector, w.ring + 1)
          log.debug('find_food: leg failed', { to: `${w.x} ${w.z}`, error: (e as Error).message })
          // Sank on a lake bed: the next leg from this spot dives into the same water (it did, twice,
          // and Pax drowned there once the action ended). Get to dry land and stop scouting.
          if (e instanceof TravelUnderwaterError) {
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
      if (seen) return found(seen, `scouted ${farthest} blocks ${sectorsText(sectors)} of ${centerName}`)
    }
    const water = rankSpots(getFoodSpots(agent), ['water'], Date.now(), bot.entity.position, dim)[0]
    const parts = [
      ...checked,
      legs ? `scouted ${farthest} blocks ${sectorsText(sectors)} of ${centerName}, no animals${p.crops ? ' or village crops' : ''}` : 'did not get to scout',
      `stopped: ${reason}`,
      ...(water ? [`saw water at ${fmtPos(water)}`] : [])
    ]
    return fail(parts.join('; '), { farthest, legs })
  }
})

// ------------------------------------------------------------------ start_farm

const PLANTS = /^(short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|lily_of_the_valley|dead_bush|sweet_berry_bush|snow)$/
/** Blocks players place: a plot near these is somebody's base or farm. */
const BUILD = /(_planks|cobblestone|stone_bricks|bricks|glass|_fence|_wall|door|torch|lantern|_bed$|chest|barrel|crafting_table|furnace|_slab|_stairs|wool|carpet|concrete|terracotta|rail|ladder|sign|hay_block|composter|bell|scaffolding|farmland)/
const FENCES = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_fence$/

/** What a plot cell is (ground at y, the block above at y+1). */
function cellKind (agent: Agent, bot: Bot, x: number, y: number, z: number, clearance: number): CellKind {
  if (offLimits(agent, bot, { x, y, z }, clearance)) return 'protected'
  const g = bot.blockAt(vec(bot, x, y, z))
  const a = bot.blockAt(vec(bot, x, y + 1, z))
  if (!g || !a) return 'other'
  if (g.name === 'water') return 'water'
  if (g.name === 'farmland') return 'farmland'
  if (BUILD.test(g.name) || BUILD.test(a.name)) return 'build'
  if (TILLABLE.includes(g.name) && (a.name === 'air' || PLANTS.test(a.name))) return 'tillable'
  // a bank one block above the water: dig the top layer off and till the dirt under it
  // (farmland is only kept wet by water at its own height or one above)
  const a2 = bot.blockAt(vec(bot, x, y + 2, z))
  if (TILLABLE.includes(g.name) && TILLABLE.includes(a.name) && a2 && (a2.name === 'air' || PLANTS.test(a2.name))) return 'tillable'
  return 'other'
}

/** A candidate plot around a water block: plot cells plus a 3-block ring checked for builds/fields. */
export function siteAt (agent: Agent, bot: Bot, water: Vec3, size: number, from: { x: number, z: number }, clearance: number): SiteCandidate {
  const h = (size - 1) / 2
  const cells: Record<string, CellKind> = {}
  for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) cells[`${dx},${dz}`] = cellKind(agent, bot, water.x + dx, water.y, water.z + dz, clearance)
  const around: CellKind[] = []
  const m = h + 3
  for (let dx = -m; dx <= m; dx++) {
    for (let dz = -m; dz <= m; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= h) continue
      if ((dx + dz) % 2) continue // every other block is plenty to spot a wall or a field
      for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(vec(bot, water.x + dx, water.y + dy, water.z + dz))
        if (b && BUILD.test(b.name)) { around.push(b.name === 'farmland' ? 'farmland' : 'build'); break }
      }
    }
  }
  return { water: { x: water.x, y: water.y, z: water.z }, cells, around, distance: Math.hypot(water.x - from.x, water.z - from.z) }
}

async function breakPlantsFor (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, want: number, clearance: number, maxMs = 4 * 60_000): Promise<{ broken: number, seeds: number }> {
  const { bot, agent, signal, log } = ctx
  const ids = ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const before = seedCount(inventory(bot))
  const until = Date.now() + maxMs
  const skip = new Set<string>()
  let broken = 0
  while (seedCount(inventory(bot)) - before < want && Date.now() < until && broken < 120) {
    checkAborted(signal)
    const target = bot.findBlocks({ matching: ids, maxDistance: 64, count: 64 })
      .map(p => bot.blockAt(p)).find(b => b && !skip.has(b.position.toString()) && !offLimits(agent, bot, b.position, clearance))
    if (!target) break
    try {
      await reachBlock(bot, target.position, signal, 2, 15_000)
      await digBlock(bot, target, signal)
      broken++
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) agent.markProtected(target.position)
      skip.add(target.position.toString())
      continue
    }
    if (broken % 6 === 0) await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 }).catch(() => 0)
  }
  await pickupNearby(bot, signal, { radius: 8, maxMs: 10_000 }).catch(() => 0)
  log.debug('start_farm: broke plants for seeds', { broken, seeds: seedCount(inventory(bot)) - before })
  return { broken, seeds: seedCount(inventory(bot)) - before }
}

/** Gets a hoe: one in the inventory, crafted from what's there, or crafted after chopping a couple of logs. */
async function getHoe (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, clearance = 48): Promise<ActionResult> {
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
async function pourWater (bot: Bot, hole: Vec3, signal: AbortSignal): Promise<boolean> {
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
async function fillBucket (bot: Bot, water: Vec3, signal: AbortSignal): Promise<boolean> {
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
async function tillAt (bot: Bot, pos: Vec3, signal: AbortSignal): Promise<boolean> {
  // lower a one-block bank first: plant on top, then the grass/dirt itself
  const top = bot.blockAt(pos.offset(0, 2, 0))
  if (top && top.name !== 'air' && PLANTS.test(top.name) && TILLABLE.includes(bot.blockAt(pos.offset(0, 1, 0))?.name ?? '')) {
    await reachBlock(bot, top.position, signal, 2, 15_000)
    await digBlock(bot, top, signal)
  }
  const bank = bot.blockAt(pos.offset(0, 1, 0))
  if (bank && TILLABLE.includes(bank.name)) {
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

const canPlace = (agent: Agent) => (agent.settings as { canPlace?: boolean } | undefined)?.canPlace !== false

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
  const pick = (from: { x: number, y: number, z: number }) => {
    // within the radius first, then as far as the loaded chunks go
    for (const r of [...new Set([p.radius, Math.max(p.radius, 96)])]) {
      const waters = surfaceWater(bot, vec(bot, from.x, from.y, from.z), r, 160, true)
      const best = chooseFarmSite(waters.map(w => siteAt(agent, bot, w, size, center!, p.spawnClearance)))
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
  if (!site && canPlace(agent)) {
    // carry water: fill a bucket if we only have an empty one
    if (!findItem(bot, 'water_bucket') && findItem(bot, 'bucket')) {
      const src = surfaceWater(bot, bot.entity.position, 64, 8)[0]
      if (src && await fillBucket(bot, src, signal).catch(() => false)) steps.push(`filled a bucket at ${fmtPos(src)}`)
    }
    if (findItem(bot, 'water_bucket')) {
      // dig a hole in flat grass and pour the water in
      const grass = bot.findBlocks({ point: vec(bot, center.x, center.y, center.z), matching: ['grass_block', 'dirt'].map(n => bot.registry.blocksByName[n]!.id), maxDistance: Math.min(32, p.radius), count: 96 })
      const cands = grass.map(g => {
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
          if (await pourWater(bot, hole, signal)) { site = dry; steps.push(`made a water hole at ${fmtPos(hole)}`) }
        } catch (e) {
          checkAborted(signal)
          log.debug('start_farm: could not make water', { error: (e as Error).message })
        }
      }
    }
  }
  if (!site) return fail(`no flat grass next to water within ${Math.max(p.radius, 96)} blocks of ${centerName} that isn't protected or somebody's build, and no water bucket${steps.length ? ` (${steps.join(', ')})` : ''}`)

  // seeds (the walk may take us away from the site; tilling walks back cell by cell)
  let inv = inventory(bot)
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
  for (const c of layout.till) {
    checkAborted(signal)
    if (site.cells[`${c.x - site.water.x},${c.z - site.water.z}`] !== 'tillable') continue
    try {
      if (await tillAt(bot, vec(bot, c.x, c.y, c.z), signal)) tilled++
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) { agent.markProtected(c); if (++refused >= 2) break }
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
  const n = getFarms(agent).length + 1
  const name = `farm:${n}`
  const farm: Farm = { name, x: site.water.x, y: site.water.y, z: site.water.z, dim, size, crop: cropName, created: Date.now(), tended: Date.now() }
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
  description: 'Food self-sufficiency: scouting for animals and village farms, starting a farm of its own, breeding animals.',
  actions: [findFood, startFarmAction, breed],
  observe: (agent) => {
    const farms = getFarms(agent).map(f => `${f.name} ${f.crop} at ${fmtPos(f)}`)
    const spots = getFoodSpots(agent).filter(s => s.kind !== 'water').length
    return farms.length || spots ? { farms, foodSpots: spots } : {}
  }
})
