// keep_fed: when hungry (or hurt and not full enough to heal) and out of food, go and get
// some: eat what's there, cook, bake, withdraw from known chests, harvest its own or a
// village farm, go back to known food spots, hunt (sparing a herd), scout further out, and
// as a last resort start a farm. The decision is a pure function (nextFoodStep) so it is
// unit-tested without a server.
import { needsSurvival, fmtPos } from '../../../core/index.ts'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z, type Agent, type ActionResult } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { getHome } from '../../../skills/navigation.ts'
import type { BehaviorContext } from '../../../brains/npc/index.ts'
import { bestFood } from '../../../skills/survival.ts'
import { HUNTABLE, herdSurplus } from '../../../skills/combat.ts'
import { CROPS, isMature } from '../../../skills/farming.ts'
import {
  animalsAround, ownFarmRipe, villageCrops, getFarms, nearestFarm, saveFarm, getFoodSpots, forgetEmptySpot, farmStatus, ripeBerries,
  shoreKelp, appleLeaves, canSmeltKelp, farmWorkFor, breakableGrass, type Farm
} from '../../../skills/food.ts'
import {
  rankSpots, seedCount, planFood, foodReportText, nextRing, recordSearch, breedPlan, foodDanger, farmChore, chorePause, rankFoodPlaces, placeSource,
  BREED_FOOD, STEP_PAUSE_MS, SEEDS_RETRY_MS, TRIP_PAUSE_MS, DEFAULT_RINGS, FAR_RINGS_FROM, RISKY_RINGS_FROM, SCOUT_GEAR, SCOUT_HUNGER_AT, SCOUT_FOOD_FLOOR,
  type FoodStep, type FoodWorld, type FoodDecision, type SearchRecord, type FoodChore, type ChoreWorld, type FoodPlace
} from '../../../skills/foodPlan.ts'
import { farmWorkCount, type FarmWork } from '../../../skills/farmPlan.ts'
import { inDangerZone } from '../../../skills/food-danger.ts'
import { rangedSituation, gearNow } from '../../../skills/ranged.ts'
import { gearScore } from '../../../skills/ranged-plan.ts'
import { wornArmorPoints } from '../../../skills/gear.ts'
import { escorting } from '../../../skills/bodyguard.ts'
import { rangedDanger } from './safety.ts'
import { pickFuel } from '../../../skills/crafting.ts'
import { knownContainers, configuredChests, sameContainer, chestView, chestTotals } from '../../../skills/containers.ts'
import { getPlaces, sameDimension } from '../../../skills/navigation.ts'
import { dist, hostilesNear } from './util.ts'
import { helpDesk } from '../../../brains/npc/help.ts'
import { tripRun } from './trip.ts'

/** Raw food -> what cooking makes of it. */
export const COOKED: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp'
}

/** Raw foods that are fine to eat uncooked in a pinch (raw chicken can poison). */
const SAFE_RAW = new Set(['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'])
const BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

export { planFood, nextFoodStep, type FoodStep, type FoodWorld, type FoodStepOptions, type FoodDecision } from '../../../skills/foodPlan.ts'

/** keep_fed's score while starving between ladder runs: above chores (chop_wood_loop 38, stay_safe's hold 40), below stay_safe's night trip home (48+). */
export const STARVING_HOLD_SCORE = 45

/** Starving (food at or below 6): keep_fed holds the body between ladder runs instead of chores. */
export function starvingHold (food: number, health: number, o: { below: number, healBelow: number }): boolean {
  return food <= 6 && isHungry(food, health, o)
}

/** Whether keep_fed wants to run at this food/health level. */
export function isHungry (food: number, health: number, o: { below: number, healBelow: number }): boolean {
  return food < o.below || (health < o.healBelow && food < 18)
}

function isFood (bot: Bot, name: string): boolean {
  const foods = (bot.registry as any).foodsByName ?? {}
  return !!foods[name] && !BAD.has(name)
}

function anyRipeCrops (bot: Bot, radius: number): number {
  const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  return bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: 16,
    useExtraInfo: (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age)
  }).length
}

/** How far keep_fed looks for berry bushes and kelp: a spruce forest's berries are a real food source where there are no animals. */
const FORAGE_RANGE = 64

/** A farm counts as due a visit when its chunk is out of sight and it was last tended this long ago. */
const FARM_DUE_MS = 20 * 60_000

/** Food in a remembered chest (nearest first). */
function foodChests (bot: Bot, agent: Agent): { x: number, y: number, z: number, item: string }[] {
  const pos = bot.entity.position
  return knownContainers(agent)
    .map(c => ({ ...c, item: Object.keys(c.contents).filter(n => isFood(bot, n)).sort((a, b) => (c.contents[b] ?? 0) - (c.contents[a] ?? 0))[0] }))
    .filter((c): c is typeof c & { item: string } => !!c.item)
    .sort((a, b) => dist(a, pos) - dist(b, pos))
}

/** A configured pantry (settings.storage.chests) looked into and found without food is left alone this long. */
const PANTRY_RECHECK_MS = 20 * 60_000
/** Configured chests further than this are not walked to for food. */
const PANTRY_RANGE = 160
const pantryChecked = new WeakMap<Agent, Map<string, number>>()

/**
 * A configured chest (settings.storage.chests) worth walking to for food: what the bot saw in
 * chests is only kept in memory, so after a restart it would not know its pantry holds food.
 * Known food chests come first (foodChests); this is for chests not looked into lately.
 */
function pantryToCheck (bot: Bot, agent: Agent, now = Date.now()): { x: number, y: number, z: number } | null {
  const pos = bot.entity.position
  const checked = pantryChecked.get(agent)
  const seen = knownContainers(agent)
  return configuredChests(agent)
    .filter(c => dist(c, pos) <= PANTRY_RANGE && now - (checked?.get(`${c.x} ${c.y} ${c.z}`) ?? 0) > PANTRY_RECHECK_MS)
    .filter(c => !seen.some(k => sameContainer(k, c) && now - k.at < PANTRY_RECHECK_MS))
    .sort((a, b) => dist(a, pos) - dist(b, pos))[0] ?? null
}

function markPantryChecked (agent: Agent, c: { x: number, y: number, z: number }, now = Date.now()): void {
  let m = pantryChecked.get(agent)
  if (!m) pantryChecked.set(agent, m = new Map())
  m.set(`${c.x} ${c.y} ${c.z}`, now)
}

const options = z.object({
  below: z.number().min(1).max(20).default(14).describe('look for food when the food bar is below this (reflexes eat at 15 when food is carried)'),
  healBelow: z.number().min(0).max(20).default(14).describe('also look for food when health is below this and food is too low to heal (<18)'),
  until: z.number().min(1).max(20).default(18).describe('keep eating until the food bar reaches this'),
  chests: z.boolean().default(true).describe('withdraw food from chests the bot has looked into'),
  chestPlace: z.string().optional().describe('a remembered place with a food chest to check first'),
  harvest: z.boolean().default(true).describe('harvest ripe crops on its own farms and village farms'),
  anyCrops: z.boolean().default(false).describe('also harvest crops that are not its own or a village\'s (e.g. its owner\'s field); off = never touch other players\' farms'),
  hunt: z.boolean().default(true).describe('hunt passive animals (adults only; never pets, named, tamed or leashed animals)'),
  keepBreeders: z.boolean().default(true).describe('spare keepAtLeast adults of each kind for breeding (only hunted when starving); off = hunt them all'),
  keepAtLeast: z.number().int().min(0).max(32).default(2).describe('breeders to spare per kind when keepBreeders is on'),
  animals: z.array(z.enum(HUNTABLE)).default([...HUNTABLE]).describe('animals it may hunt'),
  cook: z.boolean().default(true).describe('cook raw meat/potatoes when a furnace and fuel are available or craftable'),
  eatRaw: z.boolean().default(true).describe('eat raw meat when cooking is not possible (never raw chicken)'),
  radius: z.number().min(4).max(64).default(32).describe('how far to look for crops and animals'),
  places: z.boolean().default(true).describe('go back to remembered food spots (food:animals, food:village_farm)'),
  scout: z.boolean().default(true).describe('when nothing is in range, search further out (find_food), one ring wider each time a ring comes up empty'),
  rings: z.array(z.number().min(32).max(1024)).max(8).default([...DEFAULT_RINGS]).describe('search rings around home, smallest first: close, wider, wide, then far ones (by day only, after known food places)'),
  farRingsFrom: z.number().min(32).max(1024).default(FAR_RINGS_FROM).describe('rings wider than this are far: searched by day only, and only after a trip to a known food place'),
  scoutGear: z.number().min(0).max(100).default(SCOUT_GEAR).describe('gear score (armour, shield, weapon, bow, health; stone tools and no armour score about 25) from which searching rings wider than riskyRingsFrom is fine at any food level; 0 = no gear rule'),
  scoutFoodFloor: z.number().min(0).max(20).default(SCOUT_FOOD_FLOOR).describe('at or below this food no ring wider than riskyRingsFrom is started, whatever the gear: the walk would eat the rest'),
  scoutHungerAt: z.number().min(0).max(20).default(SCOUT_HUNGER_AT).describe('with gear under scoutGear, rings wider than riskyRingsFrom are searched only when food is at or below this; until then it uses its farm, bakes, waits for crops'),
  riskyRingsFrom: z.number().min(16).max(1024).default(RISKY_RINGS_FROM).describe('rings wider than this count as risky trips for the gear rule'),
  ringMemoryMinutes: z.number().min(1).max(1440).default(180).describe('remember an empty ring this long before searching it again (every scout costs food)'),
  scoutRadius: z.number().min(32).max(1024).optional().describe('old single search radius; when set it caps the rings'),
  scoutAtNight: z.boolean().default(false).describe('also make far trips (searching, known spots, its farm) at night'),
  startFarm: z.boolean().default(true).describe('farm fallback: with no proper food source (all rings empty), gather seeds, start a farm near home, plant and use it'),
  minSeeds: z.number().int().min(1).max(64).default(8).describe('seeds to have before starting a farm (picked up while searching, or by breaking grass)'),
  growFarm: z.boolean().default(true).describe('between meals (and when food is not urgent) start, tend and grow its farm alongside the other sources: replant, re-till, add cells, breed near home'),
  farmSize: z.number().int().min(3).max(9).default(9).describe('side of the square its farm grows towards around the water block'),
  seedReserve: z.number().int().min(0).max(32).default(4).describe('seeds kept for replanting: the farm only grows with seeds beyond these'),
  farmAbove: z.number().min(1).max(20).default(14).describe('food at or above this is not urgent: farm work may come before a long search'),
  seedRange: z.number().min(8).max(128).default(96).describe('how far to look for grass to break for seeds (it works outwards patch by patch)'),
  seedMinutes: z.number().min(1).max(10).default(4).describe('how long one seed-gathering run may break grass before it stops'),
  trips: z.boolean().default(true).describe('go to known food places far away (foodPlaces, its farms, found:/food: places): walk there by day, harvest and replant, bake, eat, come back'),
  tripRange: z.number().min(64).max(10_000).default(4000).describe('known food places further away than this are not worth a trip'),
  foodPlaces: z.array(z.object({
    name: z.string().optional().describe('label for logs and chat'),
    place: z.string().optional().describe('a remembered place name (e.g. farm:1) instead of coordinates'),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    dim: z.string().optional(),
    crops: z.array(z.string()).optional().describe('what grows there (wheat, carrots, potatoes)')
  })).default([]).describe('known farms and villages to go to for food (preferred over the far search rings)'),
  breed: z.boolean().default(true).describe('breed animals near home between meals when it has their food (wheat: cows, sheep; seeds: chickens; carrots: pigs)'),
  report: z.boolean().default(true).describe('when food is critical (6 or less) or every ring came up empty and nothing works, whisper the owner how far it looked and what would help (at most once an hour)')
})

type O = z.infer<typeof options>

/** The rings to search, capped by the old scoutRadius option when a profile still sets it. */
export function ringsFor (o: { rings: number[], scoutRadius?: number }): number[] {
  const rings = (o.rings.length ? [...o.rings] : [...DEFAULT_RINGS]).sort((a, b) => a - b)
  if (o.scoutRadius === undefined) return rings
  const capped = rings.filter(r => r < o.scoutRadius!)
  return [...capped, o.scoutRadius]
}

const stepOptions = (o: O) => ({
  ...o,
  growFarm: o.growFarm,
  farmAbove: o.farmAbove,
  rings: ringsFor(o),
  ringMemoryMs: o.ringMemoryMinutes * 60_000,
  keepAtLeast: o.keepBreeders ? o.keepAtLeast : 0
})

/** Night, or a thunderstorm (mobs spawn): the same test stay_safe uses, so far trips and night retreat never disagree. */
const isNightTime = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 0; return (bot as { thunderState?: number }).thunderState! > 0 || (t >= 12_542 && t <= 23_459) }

/** What keep_fed remembers between runs (agent.storage, so a restart doesn't rescan empty rings). */
interface LadderMemory { searches: SearchRecord[], paused: Partial<Record<FoodStep, number>>, lastReportAt: number, chores?: Partial<Record<FoodChore, number>>, trips?: Record<string, number> }
const MEMORY_KEY = 'foodLadder'
const memories = new WeakMap<Agent, LadderMemory>()
function memory (agent: Agent): LadderMemory {
  let m = memories.get(agent)
  if (!m) {
    const st = (agent as { storage?: Agent['storage'] }).storage
    const saved = st?.get<Partial<LadderMemory>>(MEMORY_KEY, {}) ?? {}
    m = { searches: saved.searches ?? [], paused: saved.paused ?? {}, lastReportAt: saved.lastReportAt ?? 0, chores: saved.chores ?? {}, trips: saved.trips ?? {} }
    memories.set(agent, m)
  }
  return m
}
function saveMemory (agent: Agent, m: LadderMemory): void {
  const st = (agent as { storage?: Agent['storage'] }).storage
  try { st?.set(MEMORY_KEY, m) } catch {}
}

/** The shared danger signals (stay_safe's ranged danger, surrounded, hurt with mobs near, a remembered danger zone), or null. */
export function senseDanger (agent: Agent, bot: Bot): string | null {
  const pos = bot.entity.position
  const health = typeof bot.health === 'number' ? bot.health : 20
  let ranged = false
  try {
    const r = rangedSituation(bot)
    const shield = bot.inventory?.slots?.[45]?.name === 'shield' || !!bot.inventory?.items?.().some(i => i.name === 'shield')
    ranged = rangedDanger({ active: r.active.length, patrol: r.patrol, health, armor: bot.inventory?.slots ? wornArmorPoints(bot) : 0, shield, escorting: !!escorting(agent) })
  } catch {}
  return foodDanger({ ranged, close: hostilesNear(bot, pos, 6).length, near: hostilesNear(bot, pos, 10).length, health, inZone: inDangerZone(agent, pos) })
}

/** Its nearest farm's work when the farm is loaded and within `range`. */
function nearFarmWork (agent: Agent, bot: Bot, o: O, range: number): { farm: Farm, work: FarmWork } | null {
  const farm = nearestFarm(agent, bot)
  if (!farm) return null
  const pos = bot.entity.position
  if (Math.hypot(farm.x - pos.x, farm.z - pos.z) > range) return null
  const work = farmWorkFor(agent, bot, farm, { targetSize: o.farmSize, seedReserve: o.seedReserve })
  return work ? { farm, work } : null
}

/** Seeds it saw in its own and configured chests near home (0 without gather_seeds, which takes them). */
export function chestSeedCount (agent: Agent, bot: Bot): number {
  if (!agent.getAction('gather_seeds')) return 0
  try {
    const t = chestTotals(chestView(agent, bot))
    return Object.entries(t.has).filter(([k]) => /_seeds$/.test(k)).reduce((n, [, v]) => n + v, 0)
  } catch { return 0 }
}

/** Breeding is worth it here: near home (or no home), a pair, and their food (seeds kept back). */
function breedHere (agent: Agent, bot: Bot, inv: Record<string, number>, keepSeeds: number): boolean {
  if (!agent.getAction('breed')) return false
  const home = getHome(agent)
  const pos = bot.entity.position
  if (home && Math.hypot(home.x - pos.x, home.z - pos.z) > 64) return false
  return !!breedPlan(animalsAround(agent, bot, pos, 24, Object.keys(BREED_FOOD)).adults, inv, { keepSeeds })
}

/** Every known food place: the profile's foodPlaces, its own farms, and remembered found:/food:/farm: places. */
export function knownFoodPlaces (agent: Agent, o: Pick<O, 'foodPlaces'>): FoodPlace[] {
  const places = getPlaces(agent)
  const out: FoodPlace[] = []
  for (const f of o.foodPlaces ?? []) {
    const named = f.place ? places[f.place.toLowerCase()] ?? places[f.place] : undefined
    const x = f.x ?? named?.x
    const z = f.z ?? named?.z
    if (x === undefined || z === undefined) continue
    const y = f.y ?? named?.y
    const dim = f.dim ?? named?.dimension
    out.push({ name: f.name ?? f.place ?? `${x} ${z}`, x, z, ...(y !== undefined ? { y } : {}), ...(dim ? { dim } : {}), source: 'config', ...(f.crops ? { crops: f.crops } : {}) })
  }
  for (const f of getFarms(agent)) out.push({ name: f.name, x: f.x, y: f.y + 1, z: f.z, ...(f.dim ? { dim: f.dim } : {}), source: 'farm', crops: [f.crop] })
  for (const [name, p] of Object.entries(places)) {
    const source = placeSource(name)
    if (source) out.push({ name, x: p.x, y: p.y, z: p.z, ...(p.dimension ? { dim: p.dimension } : {}), source })
  }
  return out
}

/** Known food places worth a trip from here, best first. */
function tripPlaces (agent: Agent, bot: Bot, o: O): ReturnType<typeof rankFoodPlaces> {
  if (!o.trips || !agent.getAction('goto')) return []
  return rankFoodPlaces(knownFoodPlaces(agent, o), bot.entity.position, {
    minDistance: Math.max(48, o.radius),
    maxDistance: o.tripRange,
    dim: bot.game?.dimension,
    paused: memory(agent).trips ?? {},
    inDanger: p => inDangerZone(agent, p)
  })
}

/** Reads the world into a FoodWorld. */
export function senseFood (agent: Agent, bot: Bot, o: O): FoodWorld {
  const items = bot.inventory.items()
  const names = items.map(i => i.name)
  const best = bestFood(bot)
  const ready = items.some(i => isFood(bot, i.name) && !COOKED[i.name])
  const raw = [...new Set(names.filter(n => COOKED[n]))]
  const has = (n: string) => items.filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const furnace = !!bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 }) ||
    has('furnace') > 0 || (has('cobblestone') + has('cobbled_deepslate') + has('blackstone') >= 8 && !!agent.getAction('craft'))
  const fuel = raw.some(r => pickFuel(names, r))
  const pos = bot.entity.position
  const food = typeof bot.food === 'number' ? bot.food : 20
  const health = typeof bot.health === 'number' ? bot.health : 20
  const starving = food <= 6 || health <= 6
  const farRange = Math.max(...ringsFor(o))

  let ripe = 0
  let farmDistance: number | null = null
  let farmEmpty = 0
  let farmGrowing = 0
  let farmWork: number | undefined
  let farmSeedsWanted = 0
  const farm = nearestFarm(agent, bot)
  if (farm) {
    const status = farmStatus(bot, farm)
    if (status && Math.hypot(farm.x - pos.x, farm.z - pos.z) <= Math.max(o.radius, 48)) { farmEmpty = status.empty; farmGrowing = status.growing }
    const near = (agent.getAction('tend_farm') || agent.getAction('plant')) ? nearFarmWork(agent, bot, o, Math.max(o.radius, 48)) : null
    if (near) {
      // without tend_farm only bare farmland can be planted
      farmWork = agent.getAction('tend_farm') ? farmWorkCount(near.work) : near.work.plant.length
      farmSeedsWanted = near.work.seedsWanted
    }
  }
  if (o.harvest && agent.getAction('harvest')) {
    const own = ownFarmRipe(agent, bot, o.radius)
    ripe = own?.ripe ?? 0
    if (!ripe) ripe = villageCrops(bot, pos, o.radius).length
    if (!ripe && o.anyCrops) ripe = anyRipeCrops(bot, o.radius)
    // its own farm further out: ripe if we can see it, else due after a while
    if (farm && !own) {
      const d = Math.hypot(farm.x - pos.x, farm.z - pos.z)
      const visible = !!bot.blockAt?.(pos.offset(farm.x - pos.x, farm.y - pos.y, farm.z - pos.z))
      const seenRipe = visible && !!ownFarmRipe(agent, bot, d + 1)
      if (d <= farRange && (seenRipe || (!visible && Date.now() - (farm.tended ?? farm.created) >= FARM_DUE_MS))) farmDistance = Math.round(d)
    }
  }
  const keep = o.keepBreeders ? o.keepAtLeast : 0
  let animals = 0
  let herd = 0
  if (o.hunt && agent.getAction('hunt')) {
    const seen = animalsAround(agent, bot, pos, o.radius, o.animals)
    herd = seen.total
    animals = Object.values(herdSurplus(seen.adults, keep)).reduce((a, b) => a + b, 0)
  }
  const spot = o.places && agent.getAction('goto')
    ? rankSpots(getFoodSpots(agent), ['animals', 'village_farm'], Date.now(), pos, bot.game?.dimension)
      .find(s => Math.hypot(s.x - pos.x, s.z - pos.z) <= farRange * 1.5 && !inDangerZone(agent, s))
    : undefined
  let grassSeen: boolean | undefined
  const grass = () => (grassSeen ??= breakableGrass(agent, bot, Math.min(o.seedRange, 64)).length > 0)
  const inv: Record<string, number> = {}
  for (const i of items) inv[i.name] = (inv[i.name] ?? 0) + i.count
  const seeds = seedCount(inv)
  const canBreed = breedHere(agent, bot, inv, o.minSeeds)
  const m = memory(agent)
  const forageable = agent.getAction('forage')
    ? ripeBerries(bot, pos, FORAGE_RANGE).length + (agent.canDig && canSmeltKelp(bot) ? shoreKelp(bot, pos, Math.min(FORAGE_RANGE, 32)).length : 0)
    : 0
  return {
    hasReadyFood: ready && !!best,
    raw,
    safeRaw: raw.some(r => SAFE_RAW.has(r)),
    canCook: !!agent.getAction('smelt') && furnace && fuel,
    canBake: has('wheat') >= 3 && !!agent.getAction('craft'),
    foodChest: !!agent.getAction('withdraw') && (foodChests(bot, agent).length > 0 || !!pantryToCheck(bot, agent) || (!!o.chestPlace && !!getPlaces(agent)[o.chestPlace.toLowerCase()])),
    ripeCrops: ripe,
    animals,
    herd,
    starving,
    farmDistance,
    spotDistance: spot ? Math.round(Math.hypot(spot.x - pos.x, spot.z - pos.z)) : null,
    night: isNightTime(bot),
    canScout: o.scout && !!agent.getAction('find_food'),
    hasFarm: getFarms(agent).some(f => !f.dim || f.dim === bot.game?.dimension),
    canStartFarm: o.startFarm && !!agent.getAction('start_farm') && !!agent.canDig && (seeds > 0 || grass() || !!getHome(agent)),
    food,
    health,
    seeds,
    grass: !!agent.canDig && !!agent.getAction('gather_seeds') && grass(),
    chestSeeds: chestSeedCount(agent, bot),
    farmEmpty: agent.getAction('plant') ? farmEmpty : 0,
    farmGrowing,
    ...(farmWork !== undefined ? { farmWork, farmSeedsWanted } : {}),
    forage: forageable,
    apples: agent.getAction('forage') && agent.canDig ? appleLeaves(bot, pos, 16, 8).length : 0,
    canBreed,
    danger: !!senseDanger(agent, bot),
    gear: (() => { try { return gearScore(gearNow(bot, agent)) } catch { return undefined } })(),
    searches: m.searches,
    paused: m.paused,
    lastReportAt: m.lastReportAt,
    knownPlace: (() => { const p = tripPlaces(agent, bot, o)[0]; return p ? { name: p.name, distance: Math.round(p.distance) } : null })(),
    now: Date.now()
  }
}

/** Reads what the between-meals chores need into a ChoreWorld. */
export function senseChores (agent: Agent, bot: Bot, o: O): ChoreWorld {
  const pos = bot.entity.position
  const inv = invOf(bot)
  const farm = nearestFarm(agent, bot)
  const near = farm && agent.getAction('tend_farm') ? nearFarmWork(agent, bot, o, 128) : null
  // grass it may break near the bot: around a worked base the closest grass is often further than 32 blocks, and often protected
  const grass = !!agent.canDig && !!agent.getAction('gather_seeds') && !!bot.findBlocks && breakableGrass(agent, bot, o.seedRange ?? 96).length > 0
  return {
    food: typeof bot.food === 'number' ? bot.food : 20,
    night: isNightTime(bot),
    danger: !!senseDanger(agent, bot),
    hasFarm: getFarms(agent).some(f => !f.dim || f.dim === bot.game?.dimension),
    canStartFarm: !!agent.getAction('start_farm') && !!agent.canDig,
    seeds: seedCount(inv),
    grass,
    chestSeeds: chestSeedCount(agent, bot),
    farmDistance: farm ? Math.round(Math.hypot(farm.x - pos.x, farm.z - pos.z)) : null,
    farmWork: near ? farmWorkCount(near.work) : 0,
    farmSeedsWanted: near?.work.seedsWanted ?? 0,
    farmSize: near?.work.size ?? farm?.size ?? 0,
    farmTarget: o.farmSize,
    canBreed: o.breed && breedHere(agent, bot, inv, o.minSeeds),
    paused: memory(agent).chores ?? {},
    now: Date.now()
  }
}

async function doChore (ctx: BehaviorContext, chore: FoodChore, o: O): Promise<ActionResult> {
  const { bot, agent } = ctx
  switch (chore) {
    case 'tend_farm': {
      const farm = nearestFarm(agent, bot)
      if (!farm) return { ok: false, message: 'no farm of my own' }
      return ctx.act('tend_farm', { farm: farm.name, size: o.farmSize, seedReserve: o.seedReserve })
    }
    case 'start_farm':
      return ctx.act('start_farm', { seeds: o.minSeeds })
    case 'seeds': {
      const farm = nearestFarm(agent, bot)
      const work = farm ? nearFarmWork(agent, bot, o, 128)?.work : undefined
      const want = work ? work.seedsWanted : o.minSeeds - seedCount(invOf(bot))
      return ctx.act('gather_seeds', { count: Math.max(2, Math.min(32, want)), radius: Math.min(128, o.seedRange ?? 96), maxMinutes: o.seedMinutes })
    }
    case 'breed':
      return ctx.act('breed', { keepSeeds: o.minSeeds })
  }
}

/** Goes to its farm (when not there) and runs `then` there. */
async function atFarm (ctx: BehaviorContext, farm: Farm, then: () => Promise<ActionResult>): Promise<ActionResult> {
  const far = Math.hypot(farm.x - ctx.bot.entity.position.x, farm.z - ctx.bot.entity.position.z)
  if (far > 8) {
    const there = await tripRun(ctx, { purpose: `a trip to ${farm.name}`, kind: 'food', distance: far }, () => ctx.act('goto', { x: farm.x, y: farm.y + 1, z: farm.z }))
    if (!there.ok) return { ok: false, message: `couldn't get to ${farm.name}: ${there.message}` }
  }
  return then()
}

/**
 * The trip rung: walk to the best known food place (any distance, on the surface), harvest ripe
 * crops there and replant, hunt what may be hunted, pick up seeds, bake and eat, then come back
 * home. The place is left alone for a while afterwards (longer when it had nothing).
 */
async function foodTrip (ctx: BehaviorContext, o: O): Promise<ActionResult> {
  const place = tripPlaces(ctx.agent, ctx.bot, o)[0]
  if (!place) return { ok: false, message: 'no known food place to go to' }
  // prepared and budgeted (skills/trip.ts): turns back home when food or daylight runs short
  return tripRun(ctx, { purpose: `a food trip to ${place.name}`, kind: 'food', distance: place.distance }, () => foodTripTo(ctx, o, place))
}

async function foodTripTo (ctx: BehaviorContext, o: O, place: ReturnType<typeof tripPlaces>[number]): Promise<ActionResult> {
  const { bot, agent } = ctx
  const m = memory(agent)
  const pause = (ms: number) => { m.trips = { ...(m.trips ?? {}), [place.name]: Date.now() + ms }; saveMemory(agent, m) }
  const has = (n: string) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const label = `${place.name} (${Math.round(place.distance)} blocks away${place.crops?.length ? `, ${place.crops.join(', ')}` : ''})`
  ctx.log.debug(`keep_fed trip: going to ${label}`, { place: place.name, distance: Math.round(place.distance) })
  const there = await ctx.act('goto', { x: place.x, ...(place.y !== undefined ? { y: place.y } : {}), z: place.z })
  if (!there.ok) { pause(TRIP_PAUSE_MS.empty); return { ok: false, message: `couldn't get to ${label}: ${there.message}` } }
  const got: string[] = []
  const pos = () => bot.entity.position
  if (o.harvest && agent.getAction('harvest')) {
    // the owner listed it, or it is its own farm: harvest the field; elsewhere only crops by a village
    if (place.source === 'config' || place.source === 'farm' || o.anyCrops) {
      const r = await ctx.act('harvest', { radius: 32, max: 96 })
      if (r.ok) got.push(r.message)
    } else {
      for (let i = 0; i < 3; i++) {
        const v = villageCrops(bot, pos(), 32)[0]
        if (!v) break
        const r = await ctx.act('harvest', { radius: 10, max: 32, x: v.x, y: v.y, z: v.z })
        if (!r.ok) break
        got.push(r.message)
      }
    }
  }
  if (o.hunt && agent.getAction('hunt')) {
    const keep = o.keepBreeders ? o.keepAtLeast : 0
    const seen = animalsAround(agent, bot, pos(), 32, o.animals)
    if (Object.values(herdSurplus(seen.adults, keep)).some(n => n > 0)) {
      const r = await ctx.act('hunt', { count: 3, radius: 32, keepAtLeast: keep })
      if (r.ok) got.push(r.message)
    }
  }
  // seeds for its own farm: wheat harvests bring some; break a little grass when short
  if (agent.canDig && agent.getAction('gather_seeds') && seedCount(invOf(bot)) < o.minSeeds && breakableGrass(agent, bot, 32).length) {
    const r = await ctx.act('gather_seeds', { count: o.minSeeds - seedCount(invOf(bot)), radius: 32, maxMinutes: 2, fromChests: false })
    if (r.ok) got.push(r.message)
  }
  if (has('wheat') >= 3 && agent.getAction('craft')) {
    const r = await ctx.act('craft', { item: 'bread', count: Math.floor(has('wheat') / 3) })
    if (r.ok) got.push(r.message)
  }
  if (bot.food < o.until && bestFood(bot) && bestFood(bot)?.name !== 'chicken') await ctx.act('eat')
  pause(got.length ? TRIP_PAUSE_MS.ok : TRIP_PAUSE_MS.empty)
  // come back home (its farm and base are there)
  let back = ''
  const home = getHome(agent)
  if (home && sameDimension(bot, home) && Math.hypot(home.x - pos().x, home.z - pos().z) > 64) {
    const r = await ctx.act('goto', { x: home.x, y: home.y, z: home.z })
    back = r.ok ? '; back home' : `; couldn't get back home: ${r.message}`
  }
  return got.length
    ? { ok: true, message: `trip to ${label}: ${got.join('; ')}${back}` }
    : { ok: false, message: `went to ${label}: nothing ripe or huntable there now${back}` }
}

async function doStep (ctx: BehaviorContext, d: FoodDecision, o: O): Promise<ActionResult> {
  const { bot, agent } = ctx
  const has = (n: string) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const farmRadius = (f: Farm) => Math.ceil((f.size - 1) / 2 * 1.5) + 1
  switch (d.step!) {
    case 'eat': {
      const best = bestFood(bot)
      if (best?.name === 'chicken') return { ok: false, message: 'only raw chicken left, not eating that' }
      return ctx.act('eat')
    }
    case 'cook': {
      // meat and potatoes first; kelp (one bar a piece) only when nothing better is raw
      const raw = Object.keys(COOKED).filter(n => has(n) > 0).sort((a, b) => (Number(a === 'kelp') - Number(b === 'kelp')) || has(b) - has(a))[0]
      if (!raw) return { ok: false, message: 'nothing to cook' }
      const furnaceNear = !!bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 })
      if (!furnaceNear && !has('furnace')) {
        const made = await ctx.act('craft', { item: 'furnace', count: 1 })
        if (!made.ok) return made
      }
      return ctx.act('smelt', { item: raw, count: Math.min(8, has(raw)) })
    }
    case 'bread':
      return ctx.act('craft', { item: 'bread', count: Math.floor(has('wheat') / 3) })
    case 'withdraw': {
      if (o.chestPlace && getPlaces(agent)[o.chestPlace.toLowerCase()] && agent.getAction('goto_place')) {
        const there = await ctx.act('goto_place', { name: o.chestPlace })
        if (there.ok && agent.getAction('list_container')) await ctx.act('list_container', {})
      }
      let chest = foodChests(bot, agent)[0]
      const pantry = chest ? null : pantryToCheck(bot, agent)
      if (pantry) {
        // a configured pantry it hasn't looked into lately: walk over and look inside
        markPantryChecked(agent, pantry)
        if (dist(pantry, bot.entity.position) > 4 && agent.getAction('goto')) {
          const walk = await ctx.act('goto', { x: pantry.x, y: pantry.y, z: pantry.z })
          if (!walk.ok) return walk
        }
        if (agent.getAction('list_container')) await ctx.act('list_container', { x: pantry.x, y: pantry.y, z: pantry.z })
        chest = foodChests(bot, agent)[0]
        if (!chest) return { ok: false, message: `no food in the chest at ${fmtPos(pantry)}` }
      }
      if (!chest) return { ok: false, message: 'no chest with food that I know of' }
      if (dist(chest, bot.entity.position) > 24 && agent.getAction('goto')) {
        const walk = await ctx.act('goto', { x: chest.x, y: chest.y, z: chest.z })
        if (!walk.ok) return walk
      }
      return ctx.act('withdraw', { item: chest.item, count: 16, x: chest.x, y: chest.y, z: chest.z })
    }
    case 'harvest': {
      const own = ownFarmRipe(agent, bot, o.radius)
      if (own) {
        const r = await ctx.act('harvest', { radius: farmRadius(own.farm), max: 81, x: own.farm.x, y: own.farm.y + 1, z: own.farm.z })
        if (r.ok) saveFarm(agent, { ...own.farm, tended: Date.now() })
        return r
      }
      const village = villageCrops(bot, bot.entity.position, o.radius)[0]
      if (village) return ctx.act('harvest', { radius: 10, max: 24, x: village.x, y: village.y, z: village.z })
      if (o.anyCrops) return ctx.act('harvest', { radius: o.radius, max: 24 })
      return { ok: false, message: 'no ripe crops of my own or a village nearby' }
    }
    case 'farm': {
      const farm = nearestFarm(agent, bot)
      if (!farm) return { ok: false, message: 'no farm of my own' }
      return atFarm(ctx, farm, async () => {
        saveFarm(agent, { ...farm, tended: Date.now() })
        const r = await ctx.act('harvest', { radius: farmRadius(farm), max: 81, x: farm.x, y: farm.y + 1, z: farm.z })
        return r.ok ? { ok: true, message: `${farm.name}: ${r.message}` } : { ok: false, message: `${farm.name} has nothing ripe yet` }
      })
    }
    case 'spot': {
      const pos = bot.entity.position
      const spot = rankSpots(getFoodSpots(agent), ['animals', 'village_farm'], Date.now(), pos, bot.game?.dimension)[0]
      if (!spot) return { ok: false, message: 'no food spots remembered' }
      const label = spot.kind === 'animals' ? `animal spot (${(spot.animals ?? []).join(', ') || 'animals'})` : 'village farm'
      const there = await tripRun(ctx, { purpose: `going to a ${label}`, kind: 'food', distance: Math.hypot(spot.x - pos.x, spot.z - pos.z) },
        () => ctx.act('goto', { x: spot.x, y: spot.y, z: spot.z }))
      if ((there.data as { turnedBack?: string } | undefined)?.turnedBack || (there.data as { trip?: boolean } | undefined)?.trip) return there
      const w = senseFood(agent, bot, o)
      if (w.animals > 0 || (w.starving && (w.herd ?? 0) > 0) || w.ripeCrops > 0) return { ok: true, message: `went to the ${label} at ${fmtPos(spot)}, food is there` }
      forgetEmptySpot(agent, spot.kind, spot)
      return { ok: false, message: `${there.ok ? 'went to' : 'tried to reach'} the ${label} at ${fmtPos(spot)}: nothing there now` }
    }
    case 'hunt': {
      const animal = o.animals.length === 1 ? o.animals[0] : undefined
      return ctx.act('hunt', { count: 2, radius: o.radius, keepAtLeast: d.keepAtLeast ?? 0, ...(animal ? { animal } : {}) })
    }
    case 'scout': {
      const radius = d.radius ?? Math.max(...ringsFor(o))
      return tripRun(ctx, { purpose: `scouting ${radius} blocks out for food`, kind: 'food', distance: radius }, () => ctx.act('find_food', {
        radius,
        minRadius: d.minRadius ?? 0,
        maxMinutes: Math.min(30, Math.max(3, Math.round(radius / 25))),
        atNight: o.scoutAtNight,
        animals: o.animals,
        crops: o.harvest,
        keepAtLeast: d.keepAtLeast ?? 0,
        ...(d.seeds ? { seeds: d.seeds } : {})
      }))
    }
    case 'seeds': {
      const farm = nearestFarm(agent, bot)
      const work = farm ? nearFarmWork(agent, bot, o, 256)?.work : undefined
      const want = Math.max(o.minSeeds - seedCount(invOf(bot)), work?.seedsWanted ?? (farm ? (farmStatus(bot, farm)?.empty ?? 0) - seedCount(invOf(bot)) : 0))
      return ctx.act('gather_seeds', { count: Math.max(2, Math.min(32, want)), radius: Math.min(128, o.seedRange ?? 96), maxMinutes: o.seedMinutes })
    }
    case 'trip':
      return foodTrip(ctx, o)
    case 'start_farm':
      return ctx.act('start_farm', { seeds: o.minSeeds })
    case 'plant': {
      const farm = nearestFarm(agent, bot)
      if (!farm) return { ok: false, message: 'no farm of my own' }
      if (agent.getAction('tend_farm')) return ctx.act('tend_farm', { farm: farm.name, size: o.farmSize, seedReserve: o.seedReserve })
      return atFarm(ctx, farm, async () => {
        const r = await ctx.act('plant', { radius: farmRadius(farm), x: farm.x, y: farm.y, z: farm.z })
        if (r.ok) saveFarm(agent, { ...farm, tended: Date.now() })
        return r.ok ? { ok: true, message: `${farm.name}: ${r.message}` } : r
      })
    }
    case 'breed':
      return ctx.act('breed', { keepSeeds: o.minSeeds })
    case 'forage':
      return ctx.act('forage', { radius: FORAGE_RANGE, kinds: canSmeltKelp(bot) ? ['berries', 'kelp'] : ['berries'], ...(d.apples ? { apples: true } : {}) })
    case 'report': {
      const text = foodReportText({ food: bot.food, searchedTo: d.radius, seeds: seedCount(invOf(bot)), hasFarm: getFarms(agent).length > 0, reason: d.reason })
      // through the shared help desk (settings.askHelp): same hourly limits and journal as the other
      // behaviours' help requests, so the owner isn't told twice; nobody online: say it in chat
      const asked = helpDesk(agent).ask({ behavior: 'keep_fed', reason: 'no food', key: 'no food', goal: 'find food', help: 'food, seeds or 2 animals', text, fallbackSay: true }, Date.now())
      const m = memory(agent)
      m.lastReportAt = Date.now()
      saveMemory(agent, m)
      return { ok: true, message: asked ? 'told the owner I am starving' : 'starving, already told the owner' }
    }
  }
}

function invOf (bot: Bot): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count
  return inv
}

/** A rough fingerprint of the food-related inventory: when it changes, a wait is cut short. */
function foodStock (bot: Bot): string {
  return bot.inventory.items().filter(i => isFood(bot, i.name) || i.name === 'wheat' || i.name.endsWith('_seeds') || i.name === 'coal' || i.name === 'charcoal')
    .map(i => `${i.name}:${i.count}`).sort().join(',')
}

/** Search outcomes that say nothing about the ring (cut short by night or danger) are not remembered as empty. */
const CUT_SHORT = /night fell|mobs|health is low|it is night|turned back|not ready for a trip/

export const keepFed = defineBehavior({
  name: 'keep_fed',
  capabilities: ['eat'],
  category: 'survival',
  description: 'Looks after food on its own, climbing a ladder when hungry (or hurt and too hungry to heal): eat, cook or bake what it carries; ' +
    'take food from known chests, its own or a village farm, remembered spots, animals in range (sparing breeders); search close, ' +
    'then wider, then wide (picking up seeds on the way); before the far rings (by day only) walk to a known farm or village, harvest, bake, eat and come back; ' +
    'with no proper source start a farm near home, plant it and use it, ' +
    'foraging berries, kelp (dried in a furnace) and, when desperate, apples meanwhile; when starving and nothing works, tell the owner and stay safe. ' +
    'Between meals it starts, replants, re-tills and grows its farm and breeds animals near home. Arm it so you never starve between turns.',
  options,
  requires: ['eat'],
  uses: ['withdraw', 'harvest', 'hunt', 'smelt', 'craft', 'goto', 'goto_place', 'list_container', 'find_food', 'start_farm', 'tend_farm', 'plant', 'gather_seeds', 'forage', 'breed'],
  priority: 'behavior',
  create (o, { agent }) {
    const so = stepOptions(o)
    const choreOpts = { growFarm: o.growFarm, startFarm: o.startFarm, breed: o.breed, minSeeds: o.minSeeds, farmAbove: o.farmAbove, tendRange: 128, seedReserve: o.seedReserve }
    // the ladder sets its own wait after a failed run; the controller's back-off stays short
    let retryAt = 0
    let stockAtFail = ''
    // between meals: the chore found by the last check (sensing a farm is not free, so at most every 30 s)
    let chore: { chore: FoodChore, reason: string } | null = null
    let choreCheckedAt = 0
    let idleLoggedAt = 0
    let choreRunning = false
    let holding = false
    const checkChore = (bot: Bot) => {
      if (Date.now() - choreCheckedAt < 30_000) return chore
      choreCheckedAt = Date.now()
      let sensed: ReturnType<typeof senseChores> | null = null
      try { sensed = (o.growFarm || o.breed) ? senseChores(agent, bot, o) : null; chore = sensed ? farmChore(sensed, choreOpts) : null } catch { chore = null }
      // say why it is idle between meals, at most every 5 minutes, so an idle bot is explainable from the log
      if (!chore && sensed && Date.now() - idleLoggedAt > 300_000) {
        idleLoggedAt = Date.now()
        agent.log.child('behaviors').debug(`keep_fed chores: nothing to do (${sensed.night ? 'night' : 'day'}, food ${sensed.food}, seeds ${sensed.seeds}${sensed.chestSeeds ? ` (+${sensed.chestSeeds} in my chests)` : ''}, grass in reach ${sensed.grass}, farm ${sensed.hasFarm ? `${sensed.farmSize}x${sensed.farmSize}, ${sensed.farmWork} cells of work` : 'none'}, breeding ${sensed.canBreed}${sensed.danger ? ', danger' : ''})`)
      }
      return chore
    }
    return {
      failureCooldownMs: 10_000,
      maxFailureCooldownMs: 10_000,
      goal: 'keep myself fed',
      // with `report` on, the ladder's own starving report asks (through the same help desk)
      help: () => o.report ? null : 'some food in my chest, seeds or 2 animals',
      score ({ bot, bb, current }) {
        if (!needsSurvival(bot)) return 0 // creative/spectator: no hunger
        const food = typeof bot.food === 'number' ? bot.food : 20
        const health = typeof bot.health === 'number' ? bot.health : 20
        const hungry = isHungry(food, health, o)
        if (current === 'keep_fed' && holding) return STARVING_HOLD_SCORE // waiting it out: stay_safe may still take it home
        if (current === 'keep_fed' && choreRunning && !hungry) return 22 // a chore keeps its low score; hunger takes over below
        if (current === 'keep_fed' && food < o.until && !choreRunning) return 60 + bb.needs.hunger * 30
        if (!hungry) {
          // between meals: farm work and breeding at the level of farm_setup, below following the owner's orders
          const c = checkChore(bot)
          return c ? (c.chore === 'tend_farm' || c.chore === 'start_farm' ? 22 : 21) : 0
        }
        if (Date.now() < retryAt && foodStock(bot) === stockAtFail) {
          // starving and waiting for a source (day, crops): hold the body near home instead of letting chores
          // take turns with stay_safe (chop_wood_loop 30-38, stay_safe's hold 40; its night trip home, 48+, still wins)
          return starvingHold(food, health, o) ? STARVING_HOLD_SCORE : 0
        }
        return 55 + bb.needs.hunger * 35
      },
      async run (ctx) {
        const m = memory(agent)
        if (Date.now() < retryAt && foodStock(ctx.bot) === stockAtFail && starvingHold(ctx.bot.food, ctx.bot.health, o)) {
          // waiting it out at home, where its farm and chests are; the ladder runs again when the wait is over
          holding = true
          try {
            const home = getHome(agent)
            const pos = ctx.bot.entity.position
            if (home && sameDimension(ctx.bot, home) && Math.hypot(home.x - pos.x, home.z - pos.z) > 16 && agent.getAction('go_home') && !isNightTime(ctx.bot)) {
              const r = await ctx.act('go_home', { range: 4 })
              return { ok: true, message: `starving (food ${ctx.bot.food}/20), back home to wait for food: ${r.message}` }
            }
            await ctx.wait(Math.min(15_000, Math.max(1000, retryAt - Date.now())))
            return { ok: true, message: `starving (food ${ctx.bot.food}/20), waiting for food near home` }
          } finally { holding = false }
        }
        if (!isHungry(ctx.bot.food, ctx.bot.health, o)) {
          choreCheckedAt = 0
          const c = checkChore(ctx.bot)
          chore = null
          if (!c) return { ok: true, message: 'fed, nothing to do on the farm' }
          ctx.log.debug(`keep_fed chore: ${c.chore} (${c.reason})`, { chore: c.chore, food: ctx.bot.food })
          choreRunning = true
          let r: ActionResult
          try { r = await doChore(ctx, c.chore, o) } finally { choreRunning = false }
          // a seeds run that came back short with grass still around is bad luck, not a dead end: try again soon
          const grassLeft = (r.data as { grassLeft?: boolean } | undefined)?.grassLeft
          m.chores = { ...(m.chores ?? {}), [c.chore]: Date.now() + chorePause(c.chore, r.ok, { grassLeft }) }
          saveMemory(agent, m)
          ctx.log.debug(`keep_fed chore ${c.chore}: ${r.message}`, { chore: c.chore, ok: r.ok })
          // a chore that didn't work is paused on its own; it is not a keep_fed failure
          return { ok: true, message: `${c.chore}: ${r.message}` }
        }
        const tried = new Set<FoodStep>()
        const done: string[] = []
        // what the far-reaching steps said, for a truthful report ("searched 120 blocks east, no animals; started a farm at ...")
        const notes: string[] = []
        let last: FoodDecision | null = null
        for (let i = 0; i < 14; i++) {
          if (ctx.bot.food >= o.until) break
          const world = senseFood(agent, ctx.bot, o)
          const d = planFood(world, so, tried)
          last = d
          if (!d.step) break
          ctx.log.debug(`keep_fed ladder: rung=${d.rung} step=${d.step} (${d.reason})`, { rung: d.rung, step: d.step, food: ctx.bot.food, ...(d.radius ? { radius: d.radius } : {}) })
          const r = await doStep(ctx, d, o)
          ctx.log.debug(`keep_fed ${d.step}: ${r.message}`, { step: d.step, ok: r.ok })
          if (['farm', 'spot', 'scout', 'trip', 'hunt', 'start_farm', 'seeds', 'plant', 'report'].includes(d.step) && r.message) notes.push(r.message)
          if (d.step === 'scout') {
            const why = String((r.data as { reason?: string } | undefined)?.reason ?? r.message)
            if (r.ok || !CUT_SHORT.test(why)) m.searches = recordSearch(m.searches, { radius: d.radius ?? 0, at: Date.now(), found: r.ok }, so.ringMemoryMs * 2)
            saveMemory(agent, m)
          }
          if (r.ok) {
            done.push(d.step)
            // eating succeeded: the next pass may eat again; anything else changes the world, so retry all
            // (a farm was just planted: nothing to harvest yet, so don't plant or scout again this run)
            // (a report changes nothing in the world: keep what was tried)
            if (d.step !== 'eat' && d.step !== 'report') { tried.clear(); if (d.step === 'start_farm') { tried.add('start_farm'); tried.add('scout') } }
            // scouted: don't scout again this run, but do walk to what it found (spot); been at a spot: don't go again
            // a new sighting: going there and hunting are worth trying again even if they failed a minute ago
            if (d.step === 'scout') { tried.add('scout'); delete m.paused.spot; delete m.paused.hunt; saveMemory(agent, m) }
            if (d.step === 'spot') { tried.add('scout'); tried.add('spot') }
            if (['seeds', 'plant', 'breed', 'forage', 'report', 'trip'].includes(d.step)) tried.add(d.step)
          } else if (/^(replaced|preempted)$/.test(r.message)) {
            // a reflex took the body (eating, a fight): the step didn't fail (no pause), it gets another go once the body is back
            break
          } else {
            tried.add(d.step)
            const pause = d.step === 'seeds' && (r.data as { grassLeft?: boolean } | undefined)?.grassLeft ? SEEDS_RETRY_MS : STEP_PAUSE_MS[d.step]
            if (pause) { m.paused = { ...m.paused, [d.step]: Date.now() + pause }; saveMemory(agent, m) }
            // an empty ring: try the next one in the same run (the ladder widens), unless it was cut short
            if (d.step === 'scout' && !CUT_SHORT.test(r.message) && nextRing(m.searches, so.rings, Date.now(), so.ringMemoryMs)) tried.delete('scout')
            // turned back from a trip (food or daylight short, back home now): no other trip this run
            if ((r.data as { turnedBack?: string } | undefined)?.turnedBack) break
          }
        }
        const food = ctx.bot.food
        const note = notes.length ? `; ${notes.join('; ')}` : ''
        if (food >= o.until || (done.includes('eat') && !isHungry(food, ctx.bot.health, o))) {
          retryAt = 0
          return { ok: true, message: `fed, food ${food}/20 (${done.join(', ')})${note}` }
        }
        // still hungry: wait as long as the rung says (a wider ring soon, a growing farm a few minutes, nothing at all longer)
        const next = planFood(senseFood(agent, ctx.bot, o), so)
        const wait = next.step ? 20_000 : next.retryMs
        retryAt = Date.now() + wait
        stockAtFail = foodStock(ctx.bot)
        ctx.log.debug(`keep_fed ladder: still hungry, next try in ${Math.round(wait / 1000)}s (${next.step ? `next: ${next.rung}/${next.step}, ${next.reason}` : next.reason})`,
          { food, wait: Math.round(wait / 1000), last: last?.step ?? null })
        return { ok: false, message: `still hungry (food ${food}/20): ${done.length ? `did ${done.join(', ')}, ` : ''}no more food to get${notes.length ? '' : ` (${last?.reason ?? 'nothing to try'})`}${note}` }
      }
    }
  }
})
