// keep_fed: when hungry (or hurt and not full enough to heal) and out of food, go and get
// some: eat what's there, withdraw from known chests, harvest ripe crops, hunt passive
// animals, cook raw food, eat. The decision is a pure function (nextFoodStep) so it is
// unit-tested without a server.
import { needsSurvival } from '../../../core/index.ts'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z, type Agent, type ActionResult } from '../../../core/index.ts'
import { defineBehavior } from '../types.ts'
import type { BehaviorContext } from '../../npc/index.ts'
import { bestFood } from '../../../skills/survival.ts'
import { huntRefusal, HUNTABLE, type HuntCandidate } from '../../../skills/combat.ts'
import { CROPS, isMature } from '../../../skills/farming.ts'
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

export type FoodStep = 'eat' | 'cook' | 'bread' | 'withdraw' | 'harvest' | 'hunt'

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
  ripeCrops: number
  animals: number
}

export interface FoodStepOptions {
  chests: boolean
  harvest: boolean
  hunt: boolean
  cook: boolean
  eatRaw: boolean
}

/**
 * The next step towards being fed, or null when nothing is left to try. `tried` holds steps
 * that already failed this run, so the loop moves on instead of repeating them.
 */
export function nextFoodStep (w: FoodWorld, o: FoodStepOptions, tried: ReadonlySet<FoodStep> = new Set()): FoodStep | null {
  const ok = (s: FoodStep) => !tried.has(s)
  if (w.hasReadyFood && ok('eat')) return 'eat'
  if (o.cook && w.raw.length && w.canCook && ok('cook')) return 'cook'
  if (w.canBake && ok('bread')) return 'bread'
  if (o.eatRaw && w.safeRaw && ok('eat')) return 'eat'
  if (o.chests && w.foodChest && ok('withdraw')) return 'withdraw'
  if (o.harvest && w.ripeCrops > 0 && ok('harvest')) return 'harvest'
  if (o.hunt && w.animals > 0 && ok('hunt')) return 'hunt'
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

function huntable (bot: Bot, agent: Agent, radius: number, animals: readonly string[]): number {
  const pos = bot.entity.position
  let n = 0
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e.position || e.position.distanceTo(pos) > radius) continue
    const keys = (bot.registry as any).entitiesByName?.[e.name ?? '']?.metadataKeys as string[] | undefined
    if (huntRefusal(e as HuntCandidate, { animals, metadataKeys: keys })) continue
    if (agent.protectedAreas?.isProtected(e.position)) continue
    n++
  }
  return n
}

function ripeCrops (bot: Bot, radius: number): number {
  const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  return bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: 16,
    useExtraInfo: (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age)
  }).length
}

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
  harvest: z.boolean().default(true).describe('harvest ripe crops nearby'),
  hunt: z.boolean().default(true).describe('hunt passive animals (never pets, named, tamed or leashed animals)'),
  animals: z.array(z.enum(HUNTABLE)).default([...HUNTABLE]).describe('animals it may hunt'),
  cook: z.boolean().default(true).describe('cook raw meat/potatoes when a furnace and fuel are available or craftable'),
  eatRaw: z.boolean().default(true).describe('eat raw meat when cooking is not possible (never raw chicken)'),
  radius: z.number().min(4).max(64).default(32).describe('how far to look for crops and animals')
})

type O = z.infer<typeof options>

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
  return {
    hasReadyFood: ready && !!best,
    raw,
    safeRaw: raw.some(r => SAFE_RAW.has(r)),
    canCook: !!agent.getAction('smelt') && furnace && fuel,
    canBake: has('wheat') >= 3 && !!agent.getAction('craft'),
    foodChest: !!agent.getAction('withdraw') && (foodChests(bot, agent).length > 0 || (!!o.chestPlace && !!getPlaces(agent)[o.chestPlace.toLowerCase()])),
    ripeCrops: o.harvest && agent.getAction('harvest') ? ripeCrops(bot, o.radius) : 0,
    animals: o.hunt && agent.getAction('hunt') ? huntable(bot, agent, o.radius, o.animals) : 0
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
    case 'harvest':
      return ctx.act('harvest', { radius: o.radius, max: 24 })
    case 'hunt': {
      const animal = o.animals.length === 1 ? o.animals[0] : undefined
      return ctx.act('hunt', { count: 2, radius: o.radius, ...(animal ? { animal } : {}) })
    }
  }
}

export const keepFed = defineBehavior({
  name: 'keep_fed',
  category: 'survival',
  description: 'Looks after food on its own: when hungry (or hurt and too hungry to heal) it eats, and when it has nothing to eat it ' +
    'takes food from known chests, harvests ripe crops, hunts passive animals and cooks the meat. Arm it so you never starve between turns.',
  options,
  requires: ['eat'],
  uses: ['withdraw', 'harvest', 'hunt', 'smelt', 'craft', 'goto', 'goto_place', 'list_container'],
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
        for (let i = 0; i < 10; i++) {
          if (ctx.bot.food >= o.until) break
          const world = senseFood(agent, ctx.bot, o)
          const step = nextFoodStep(world, o, tried)
          if (!step) break
          const r = await doStep(ctx, step, o)
          ctx.log.debug(`keep_fed ${step}: ${r.message}`, { step, ok: r.ok })
          if (r.ok) {
            done.push(step)
            // eating succeeded: the next pass may eat again; anything else changes the world, so retry all
            if (step !== 'eat') tried.clear()
          } else {
            tried.add(step)
          }
        }
        const food = ctx.bot.food
        if (food >= o.until || (done.includes('eat') && !isHungry(food, ctx.bot.health, o))) return { ok: true, message: `fed, food ${food}/20 (${done.join(', ')})` }
        return { ok: false, message: `still hungry (food ${food}/20): ${done.length ? `did ${done.join(', ')}, ` : ''}no more food to get nearby` }
      }
    }
  }
})
