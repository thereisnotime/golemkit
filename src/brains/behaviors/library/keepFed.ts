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
  animalsAround, ownFarmRipe, villageCrops, getFarms, nearestFarm, saveFarm, getFoodSpots, forgetEmptySpot
} from '../../../skills/food.ts'
import { rankSpots, seedCount } from '../../../skills/foodPlan.ts'
import { pickFuel } from '../../../skills/crafting.ts'
import { knownContainers } from '../../../skills/containers.ts'
import { getPlaces } from '../../../skills/navigation.ts'
import { dist } from './util.ts'

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

export type FoodStep = 'eat' | 'cook' | 'bread' | 'withdraw' | 'harvest' | 'farm' | 'spot' | 'hunt' | 'scout' | 'start_farm'

/** What keep_fed knows about the bot and its surroundings when choosing the next step. */
export interface FoodWorld {
  /** Ready food in the inventory (not raw meat or raw potato). */
  hasReadyFood: boolean
  /** Raw foods in the inventory that cooking would improve. */
  raw: string[]
  /** Raw foods that are safe to eat uncooked. */
  safeRaw: boolean
  /** Can cook now: smelt action, a furnace (nearby, carried or craftable) and fuel. */
  canCook: boolean
  /** Wheat for at least one bread, and the craft action. */
  canBake: boolean
  /** A known chest with food that the bot may withdraw from. */
  foodChest: boolean
  /** Ripe crops in range it may take: its own farm, a village farm (or any, with anyCrops). */
  ripeCrops: number
  /** Animals in range it may hunt now: adults above keepAtLeast per kind. */
  animals: number
  /** All huntable adults in range, herd included (hunted only when starving). */
  herd?: number
  /** Health or food critically low: the herd minimum no longer applies. */
  starving?: boolean
  /** Distance to its own farm when that has ripe crops (or is due a visit), else null. */
  farmDistance?: number | null
  /** Distance to the best remembered food spot (animals, village farm), else null. */
  spotDistance?: number | null
  /** Night: no long trips unless scoutAtNight. */
  night?: boolean
  /** The find_food action is there. */
  canScout?: boolean
  /** It has a farm of its own (farm:<n>). */
  hasFarm?: boolean
  /** start_farm is there, digging is allowed and it has seeds or grass to get them from. */
  canStartFarm?: boolean
}

export interface FoodStepOptions {
  chests: boolean
  harvest: boolean
  hunt: boolean
  cook: boolean
  eatRaw: boolean
  /** Go and harvest its own farm (default true). */
  farms?: boolean
  /** Go back to remembered food spots (default true). */
  places?: boolean
  /** Scout beyond the radius (default false here; keep_fed's option defaults to true). */
  scout?: boolean
  scoutAtNight?: boolean
  /** Start a farm when it has none (default false here; keep_fed's option defaults to true). */
  startFarm?: boolean
  /** Beyond this distance a trip counts as far (no far trips at night). */
  radius?: number
}

/**
 * The next step towards being fed, or null when nothing is left to try. `tried` holds steps
 * that already failed this run, so the loop moves on instead of repeating them. Order: eat,
 * cook, bake, (eat raw), chest, crops in range, own farm, known food spot, hunt, scout, start
 * a farm. A known spot further than `radius` only wins over hunting when there is nothing to
 * hunt here; no far trips (farm, spot, scouting, farm building) at night unless scoutAtNight.
 */
export function nextFoodStep (w: FoodWorld, o: FoodStepOptions, tried: ReadonlySet<FoodStep> = new Set()): FoodStep | null {
  const ok = (s: FoodStep) => !tried.has(s)
  const far = (d: number) => o.radius !== undefined && d > o.radius
  const dayOrBold = !w.night || !!o.scoutAtNight
  const mayGo = (d: number) => !far(d) || dayOrBold
  const huntable = w.animals > 0 || (!!w.starving && (w.herd ?? 0) > 0)
  if (w.hasReadyFood && ok('eat')) return 'eat'
  if (o.cook && w.raw.length && w.canCook && ok('cook')) return 'cook'
  if (w.canBake && ok('bread')) return 'bread'
  if (o.eatRaw && w.safeRaw && ok('eat')) return 'eat'
  if (o.chests && w.foodChest && ok('withdraw')) return 'withdraw'
  if (o.harvest && w.ripeCrops > 0 && ok('harvest')) return 'harvest'
  if (o.harvest && o.farms !== false && w.farmDistance != null && mayGo(w.farmDistance) && ok('farm')) return 'farm'
  // a spot counts only when we are not standing at it already (within 16 blocks the hunt/harvest steps see it)
  if (o.places !== false && w.spotDistance != null && w.spotDistance > 16 && mayGo(w.spotDistance) && (!huntable || !far(w.spotDistance)) && ok('spot')) return 'spot'
  if (o.hunt && huntable && ok('hunt')) return 'hunt'
  if (o.scout && w.canScout && dayOrBold && ok('scout')) return 'scout'
  if (o.startFarm && !w.hasFarm && w.canStartFarm && dayOrBold && ok('start_farm')) return 'start_farm'
  return null
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
  hunt: z.boolean().default(true).describe('hunt passive animals (never pets, named, tamed or leashed animals)'),
  keepAtLeast: z.number().int().min(0).max(32).default(2).describe('leave at least this many adults of each kind (only hunted when starving: health or food 6 or less)'),
  animals: z.array(z.enum(HUNTABLE)).default([...HUNTABLE]).describe('animals it may hunt'),
  cook: z.boolean().default(true).describe('cook raw meat/potatoes when a furnace and fuel are available or craftable'),
  eatRaw: z.boolean().default(true).describe('eat raw meat when cooking is not possible (never raw chicken)'),
  radius: z.number().min(4).max(64).default(32).describe('how far to look for crops and animals'),
  places: z.boolean().default(true).describe('go back to remembered food spots (food:animals, food:village_farm)'),
  scout: z.boolean().default(true).describe('when nothing is in range, scout further out (find_food) for animals and village farms'),
  scoutRadius: z.number().min(32).max(512).default(200).describe('how far from home to scout'),
  scoutAtNight: z.boolean().default(false).describe('also make far trips (scouting, known spots, its farm) at night'),
  startFarm: z.boolean().default(true).describe('as a last resort, start a farm (start_farm) when it has none and has or can get seeds')
})

type O = z.infer<typeof options>

/** Night, or a thunderstorm (mobs spawn): the same test stay_safe uses, so far trips and night retreat never disagree. */
const isNightTime = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 0; return (bot as { thunderState?: number }).thunderState! > 0 || (t >= 12_542 && t <= 23_459) }

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

  let ripe = 0
  let farmDistance: number | null = null
  if (o.harvest && agent.getAction('harvest')) {
    const own = ownFarmRipe(agent, bot, o.radius)
    ripe = own?.ripe ?? 0
    if (!ripe) ripe = villageCrops(bot, pos, o.radius).length
    if (!ripe && o.anyCrops) ripe = anyRipeCrops(bot, o.radius)
    // its own farm further out: ripe if we can see it, else due after a while
    const farm = nearestFarm(agent, bot)
    if (farm && !own) {
      const d = Math.hypot(farm.x - pos.x, farm.z - pos.z)
      const visible = !!bot.blockAt?.(pos.offset(farm.x - pos.x, farm.y - pos.y, farm.z - pos.z))
      const seenRipe = visible && !!ownFarmRipe(agent, bot, d + 1)
      if (d <= o.scoutRadius && (seenRipe || (!visible && Date.now() - (farm.tended ?? farm.created) >= FARM_DUE_MS))) farmDistance = Math.round(d)
    }
  }
  let animals = 0
  let herd = 0
  if (o.hunt && agent.getAction('hunt')) {
    const seen = animalsAround(agent, bot, pos, o.radius, o.animals)
    herd = seen.total
    animals = Object.values(herdSurplus(seen.adults, o.keepAtLeast)).reduce((a, b) => a + b, 0)
  }
  const spot = o.places && agent.getAction('goto')
    ? rankSpots(getFoodSpots(agent), ['animals', 'village_farm'], Date.now(), pos, bot.game?.dimension)
      .find(s => Math.hypot(s.x - pos.x, s.z - pos.z) <= o.scoutRadius * 1.5)
    : undefined
  const grass = () => {
    const ids = ['short_grass', 'grass', 'tall_grass'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    return !!bot.findBlock({ matching: ids, maxDistance: 32 })
  }
  const inv: Record<string, number> = {}
  for (const i of items) inv[i.name] = (inv[i.name] ?? 0) + i.count
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
    canStartFarm: o.startFarm && !!agent.getAction('start_farm') && !!agent.canDig && (seedCount(inv) > 0 || grass() || !!getHome(agent))
  }
}

async function doStep (ctx: BehaviorContext, step: FoodStep, o: O): Promise<ActionResult> {
  const { bot, agent } = ctx
  const has = (n: string) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  switch (step) {
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
        const r = await ctx.act('harvest', { radius: Math.ceil((own.farm.size - 1) / 2 * 1.5) + 1, max: 81, x: own.farm.x, y: own.farm.y + 1, z: own.farm.z })
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
      if (Math.hypot(farm.x - bot.entity.position.x, farm.z - bot.entity.position.z) > 8) {
        const there = await ctx.act('goto', { x: farm.x, y: farm.y + 1, z: farm.z })
        if (!there.ok) return { ok: false, message: `couldn't get to ${farm.name}: ${there.message}` }
      }
      saveFarm(agent, { ...farm, tended: Date.now() })
      const r = await ctx.act('harvest', { radius: Math.ceil((farm.size - 1) / 2 * 1.5) + 1, max: 81, x: farm.x, y: farm.y + 1, z: farm.z })
      return r.ok ? { ok: true, message: `${farm.name}: ${r.message}` } : { ok: false, message: `${farm.name} has nothing ripe yet` }
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
      const w = senseFood(agent, bot, o)
      return ctx.act('hunt', { count: 2, radius: o.radius, keepAtLeast: w.starving ? 0 : o.keepAtLeast, ...(animal ? { animal } : {}) })
    }
    case 'scout': {
      const w = senseFood(agent, bot, o)
      return ctx.act('find_food', { radius: o.scoutRadius, atNight: o.scoutAtNight, animals: o.animals, crops: o.harvest, keepAtLeast: w.starving ? 0 : o.keepAtLeast })
    }
    case 'start_farm':
      return ctx.act('start_farm', {})
  }
}

export const keepFed = defineBehavior({
  name: 'keep_fed',
  category: 'survival',
  description: 'Looks after food on its own: when hungry (or hurt and too hungry to heal) it eats, and when it has nothing to eat it ' +
    'cooks or bakes, takes food from known chests, harvests its own or a village farm, goes back to remembered food spots, ' +
    'hunts passive animals (sparing a small herd), scouts further out when nothing is near, and as a last resort starts a farm. ' +
    'Arm it so you never starve between turns.',
  options,
  requires: ['eat'],
  uses: ['withdraw', 'harvest', 'hunt', 'smelt', 'craft', 'goto', 'goto_place', 'list_container', 'find_food', 'start_farm'],
  priority: 'behavior',
  create (o, { agent }) {
    return {
      failureCooldownMs: 30_000,
      maxFailureCooldownMs: 300_000,
      score ({ bot, bb, current }) {
        if (!needsSurvival(bot)) return 0 // creative/spectator: no hunger
        const food = typeof bot.food === 'number' ? bot.food : 20
        const health = typeof bot.health === 'number' ? bot.health : 20
        if (current === 'keep_fed' && food < o.until) return 60 + bb.needs.hunger * 30
        if (!isHungry(food, health, o)) return 0
        return 55 + bb.needs.hunger * 35
      },
      async run (ctx) {
        const tried = new Set<FoodStep>()
        const done: string[] = []
        // what the far-reaching steps said, for a truthful report ("scouted 180 blocks east, no animals; started a farm at ...")
        const notes: string[] = []
        for (let i = 0; i < 12; i++) {
          if (ctx.bot.food >= o.until) break
          const world = senseFood(agent, ctx.bot, o)
          const step = nextFoodStep(world, o, tried)
          if (!step) break
          const r = await doStep(ctx, step, o)
          ctx.log.debug(`keep_fed ${step}: ${r.message}`, { step, ok: r.ok })
          if (['farm', 'spot', 'scout', 'start_farm'].includes(step) && r.message) notes.push(r.message)
          if (r.ok) {
            done.push(step)
            // eating succeeded: the next pass may eat again; anything else changes the world, so retry all
            // (a farm was just planted: nothing to harvest yet, so don't scout or plant again this run)
            if (step !== 'eat') { tried.clear(); if (step === 'start_farm') { tried.add('start_farm'); tried.add('scout') } }
            // scouted: don't scout again this run, but do walk to what it found (spot); been at a spot: don't go again
            if (step === 'scout') tried.add('scout')
            if (step === 'spot') { tried.add('scout'); tried.add('spot') }
          } else {
            tried.add(step)
          }
        }
        const food = ctx.bot.food
        const note = notes.length ? `; ${notes.join('; ')}` : ''
        if (food >= o.until || (done.includes('eat') && !isHungry(food, ctx.bot.health, o))) return { ok: true, message: `fed, food ${food}/20 (${done.join(', ')})${note}` }
        return { ok: false, message: `still hungry (food ${food}/20): ${done.length ? `did ${done.join(', ')}, ` : ''}no more food to get${notes.length ? '' : ' nearby'}${note}` }
      }
    }
  }
})
