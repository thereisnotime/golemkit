// keep_fed: when hungry (or hurt and not full enough to heal) and out of food, go and get
// some: eat what's there, cook, bake, withdraw from known chests, harvest its own or a
// village farm, go back to known food spots, hunt (sparing a herd), scout further out, and
// as a last resort start a farm. The decision is a pure function (nextFoodStep) so it is
// unit-tested without a server.
import { needsSurvival, fmtPos } from '../../../core/index.ts'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z, type Agent, type ActionResult } from '../../../core/index.ts'
import { defineBehavior } from '../types.ts'
import { getHome } from '../../../skills/navigation.ts'
import type { BehaviorContext } from '../../npc/index.ts'
import { bestFood } from '../../../skills/survival.ts'
import { HUNTABLE, herdSurplus } from '../../../skills/combat.ts'
import { CROPS, isMature } from '../../../skills/farming.ts'
import {
  animalsAround, ownFarmRipe, villageCrops, getFarms, nearestFarm, saveFarm, getFoodSpots, forgetEmptySpot, farmStatus, ripeBerries, type Farm
} from '../../../skills/food.ts'
import {
  rankSpots, seedCount, planFood, nextRing, recordSearch, breedPlan, BREED_FOOD, STEP_PAUSE_MS,
  type FoodStep, type FoodWorld, type FoodDecision, type SearchRecord
} from '../../../skills/foodPlan.ts'
import { pickFuel } from '../../../skills/crafting.ts'
import { knownContainers } from '../../../skills/containers.ts'
import { getPlaces } from '../../../skills/navigation.ts'
import { dist, hostilesNear, ownerTarget } from './util.ts'

/** Raw food -> what cooking makes of it. */
export const COOKED: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
}

/** Raw foods that are fine to eat uncooked in a pinch (raw chicken can poison). */
const SAFE_RAW = new Set(['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'])
const BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

export { planFood, nextFoodStep, type FoodStep, type FoodWorld, type FoodStepOptions, type FoodDecision } from '../../../skills/foodPlan.ts'

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
  rings: z.array(z.number().min(32).max(512)).max(6).default([48, 120, 250]).describe('search rings around home, smallest first: close, wider, wide'),
  ringMemoryMinutes: z.number().min(1).max(240).default(20).describe('remember an empty ring this long before searching it again'),
  scoutRadius: z.number().min(32).max(512).optional().describe('old single search radius; when set it caps the rings'),
  scoutAtNight: z.boolean().default(false).describe('also make far trips (searching, known spots, its farm) at night'),
  startFarm: z.boolean().default(true).describe('farm fallback: with no proper food source (all rings empty), gather seeds, start a farm near home, plant and use it'),
  minSeeds: z.number().int().min(1).max(64).default(8).describe('seeds to have before starting a farm (picked up while searching, or by breaking grass)'),
  report: z.boolean().default(true).describe('when food is critical (6 or less) and nothing works, tell the owner (at most every 10 minutes)')
})

type O = z.infer<typeof options>

/** The rings to search, capped by the old scoutRadius option when a profile still sets it. */
export function ringsFor (o: { rings: number[], scoutRadius?: number }): number[] {
  const rings = (o.rings.length ? [...o.rings] : [48, 120, 250]).sort((a, b) => a - b)
  if (o.scoutRadius === undefined) return rings
  const capped = rings.filter(r => r < o.scoutRadius!)
  return [...capped, o.scoutRadius]
}

const stepOptions = (o: O) => ({
  ...o,
  rings: ringsFor(o),
  ringMemoryMs: o.ringMemoryMinutes * 60_000,
  keepAtLeast: o.keepBreeders ? o.keepAtLeast : 0
})

/** Night, or a thunderstorm (mobs spawn): the same test stay_safe uses, so far trips and night retreat never disagree. */
const isNightTime = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 0; return (bot as { thunderState?: number }).thunderState! > 0 || (t >= 12_542 && t <= 23_459) }

/** What keep_fed remembers between runs (agent.storage, so a restart doesn't rescan empty rings). */
interface LadderMemory { searches: SearchRecord[], paused: Partial<Record<FoodStep, number>>, lastReportAt: number }
const MEMORY_KEY = 'foodLadder'
const memories = new WeakMap<Agent, LadderMemory>()
function memory (agent: Agent): LadderMemory {
  let m = memories.get(agent)
  if (!m) {
    const st = (agent as { storage?: Agent['storage'] }).storage
    const saved = st?.get<Partial<LadderMemory>>(MEMORY_KEY, {}) ?? {}
    m = { searches: saved.searches ?? [], paused: saved.paused ?? {}, lastReportAt: saved.lastReportAt ?? 0 }
    memories.set(agent, m)
  }
  return m
}
function saveMemory (agent: Agent, m: LadderMemory): void {
  const st = (agent as { storage?: Agent['storage'] }).storage
  try { st?.set(MEMORY_KEY, m) } catch {}
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
  const farm = nearestFarm(agent, bot)
  if (farm) {
    const status = farmStatus(bot, farm)
    if (status && Math.hypot(farm.x - pos.x, farm.z - pos.z) <= Math.max(o.radius, 48)) { farmEmpty = status.empty; farmGrowing = status.growing }
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
      .find(s => Math.hypot(s.x - pos.x, s.z - pos.z) <= farRange * 1.5)
    : undefined
  const grass = () => {
    const ids = ['short_grass', 'grass', 'tall_grass', 'fern'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    return !!bot.findBlock({ matching: ids, maxDistance: 32 })
  }
  const inv: Record<string, number> = {}
  for (const i of items) inv[i.name] = (inv[i.name] ?? 0) + i.count
  const seeds = seedCount(inv)
  const canBreed = !!agent.getAction('breed') && !!breedPlan(animalsAround(agent, bot, pos, 24, Object.keys(BREED_FOOD)).adults, inv)
  const hostiles = hostilesNear(bot, pos, 16)
  const m = memory(agent)
  return {
    hasReadyFood: ready && !!best,
    raw,
    safeRaw: raw.some(r => SAFE_RAW.has(r)),
    canCook: !!agent.getAction('smelt') && furnace && fuel,
    canBake: has('wheat') >= 3 && !!agent.getAction('craft'),
    foodChest: !!agent.getAction('withdraw') && (foodChests(bot, agent).length > 0 || (!!o.chestPlace && !!getPlaces(agent)[o.chestPlace.toLowerCase()])),
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
    farmEmpty: agent.getAction('plant') ? farmEmpty : 0,
    farmGrowing,
    forage: agent.getAction('forage') ? ripeBerries(bot, pos, o.radius).length : 0,
    canBreed,
    danger: hostiles.length >= 2 || (hostiles.length >= 1 && health <= 8),
    searches: m.searches,
    paused: m.paused,
    lastReportAt: m.lastReportAt,
    now: Date.now()
  }
}

/** Goes to its farm (when not there) and runs `then` there. */
async function atFarm (ctx: BehaviorContext, farm: Farm, then: () => Promise<ActionResult>): Promise<ActionResult> {
  if (Math.hypot(farm.x - ctx.bot.entity.position.x, farm.z - ctx.bot.entity.position.z) > 8) {
    const there = await ctx.act('goto', { x: farm.x, y: farm.y + 1, z: farm.z })
    if (!there.ok) return { ok: false, message: `couldn't get to ${farm.name}: ${there.message}` }
  }
  return then()
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
      const raw = Object.keys(COOKED).filter(n => has(n) > 0).sort((a, b) => has(b) - has(a))[0]
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
      const chest = foodChests(bot, agent)[0]
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
      const there = await ctx.act('goto', { x: spot.x, y: spot.y, z: spot.z })
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
      return ctx.act('find_food', {
        radius,
        minRadius: d.minRadius ?? 0,
        maxMinutes: Math.min(30, Math.max(3, Math.round(radius / 25))),
        atNight: o.scoutAtNight,
        animals: o.animals,
        crops: o.harvest,
        keepAtLeast: d.keepAtLeast ?? 0,
        ...(d.seeds ? { seeds: d.seeds } : {})
      })
    }
    case 'seeds': {
      const farm = nearestFarm(agent, bot)
      const want = Math.max(o.minSeeds, farm ? (farmStatus(bot, farm)?.empty ?? 0) : 0) - seedCount(invOf(bot))
      return ctx.act('gather_seeds', { count: Math.max(2, Math.min(32, want)), radius: 32 })
    }
    case 'start_farm':
      return ctx.act('start_farm', { seeds: o.minSeeds })
    case 'plant': {
      const farm = nearestFarm(agent, bot)
      if (!farm) return { ok: false, message: 'no farm of my own' }
      return atFarm(ctx, farm, async () => {
        const r = await ctx.act('plant', { radius: farmRadius(farm), x: farm.x, y: farm.y, z: farm.z })
        if (r.ok) saveFarm(agent, { ...farm, tended: Date.now() })
        return r.ok ? { ok: true, message: `${farm.name}: ${r.message}` } : r
      })
    }
    case 'breed':
      return ctx.act('breed', { keepSeeds: o.minSeeds })
    case 'forage':
      return ctx.act('forage', { radius: o.radius })
    case 'report': {
      let owner: { name: string } | null = null
      try { owner = ownerTarget(agent, bot) } catch {}
      const text = `I'm starving (food ${bot.food}/20) and can't find anything to eat: ${d.reason}. Staying safe for now; food would help.`
      if (owner && bot.players?.[owner.name]) agent.whisper(owner.name, text); else agent.say(text)
      const m = memory(agent)
      m.lastReportAt = Date.now()
      saveMemory(agent, m)
      return { ok: true, message: 'told the owner I am starving' }
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
const CUT_SHORT = /night fell|mobs|health is low|it is night/

export const keepFed = defineBehavior({
  name: 'keep_fed',
  category: 'survival',
  description: 'Looks after food on its own, climbing a ladder when hungry (or hurt and too hungry to heal): eat, cook or bake what it carries; ' +
    'take food from known chests, its own or a village farm, remembered spots, animals in range (sparing breeders); search close, ' +
    'then wider, then wide (picking up seeds on the way); with no proper source start a farm near home, plant it and use it, ' +
    'picking berries meanwhile; when starving and nothing works, tell the owner and stay safe. Arm it so you never starve between turns.',
  options,
  requires: ['eat'],
  uses: ['withdraw', 'harvest', 'hunt', 'smelt', 'craft', 'goto', 'goto_place', 'list_container', 'find_food', 'start_farm', 'plant', 'gather_seeds', 'forage', 'breed'],
  priority: 'behavior',
  create (o, { agent }) {
    const so = stepOptions(o)
    // the ladder sets its own wait after a failed run; the controller's back-off stays short
    let retryAt = 0
    let stockAtFail = ''
    return {
      failureCooldownMs: 10_000,
      maxFailureCooldownMs: 10_000,
      score ({ bot, bb, current }) {
        if (!needsSurvival(bot)) return 0 // creative/spectator: no hunger
        const food = typeof bot.food === 'number' ? bot.food : 20
        const health = typeof bot.health === 'number' ? bot.health : 20
        if (current === 'keep_fed' && food < o.until) return 60 + bb.needs.hunger * 30
        if (!isHungry(food, health, o)) return 0
        if (Date.now() < retryAt && foodStock(bot) === stockAtFail) return 0
        return 55 + bb.needs.hunger * 35
      },
      async run (ctx) {
        const m = memory(agent)
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
          if (['farm', 'spot', 'scout', 'start_farm', 'seeds', 'plant', 'report'].includes(d.step) && r.message) notes.push(r.message)
          if (d.step === 'scout') {
            const why = String((r.data as { reason?: string } | undefined)?.reason ?? r.message)
            if (r.ok || !CUT_SHORT.test(why)) m.searches = recordSearch(m.searches, { radius: d.radius ?? 0, at: Date.now(), found: r.ok })
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
            if (['seeds', 'plant', 'breed', 'forage', 'report'].includes(d.step)) tried.add(d.step)
          } else {
            tried.add(d.step)
            const pause = STEP_PAUSE_MS[d.step]
            if (pause) { m.paused = { ...m.paused, [d.step]: Date.now() + pause }; saveMemory(agent, m) }
            // an empty ring: try the next one in the same run (the ladder widens), unless it was cut short
            if (d.step === 'scout' && !CUT_SHORT.test(r.message) && nextRing(m.searches, so.rings, Date.now(), so.ringMemoryMs)) tried.delete('scout')
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
