// farm_setup: sets up a farm of its own and keeps it going: start one when it has none (seeds
// from grass, a hoe, flat grass by water), harvest and replant it when it is due, bake bread
// from the wheat, and breed animals it has food for. The choice of task is a pure function
// (nextFarmTask) so it is unit-tested without a server.
import type { Bot } from 'mineflayer'
import { z, needsSurvival, type Agent } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { getHome } from '../../../skills/navigation.ts'
import { getFarms, nearestFarm, ownFarmRipe, saveFarm, animalsAround, type Farm } from '../../../skills/food.ts'
import { breadToBake, breedPlan, seedCount, BREED_FOOD } from '../../../skills/foodPlan.ts'
import { isHungry } from './keepFed.ts'
import { tripRun } from './trip.ts'
import { foodSourceChoice, runFoodSource, foodSettings } from '../../../skills/foodSources.ts'
import { foodSourceText, type FoodSourceChoice } from '../../../skills/foodSourcePlan.ts'

export type FarmTask = 'setup' | 'source' | 'tend' | 'bake' | 'breed'

export interface FarmState {
  night: boolean
  /** keep_fed territory: let it run first. */
  hungry: boolean
  hasFarm: boolean
  /** Has seeds, or grass nearby (or a home: start_farm looks there), plus start_farm and digging. */
  canSetUp: boolean
  /** Distance to its nearest farm (null without one). */
  farmDistance: number | null
  /** Ripe crops seen on the farm (0 when out of sight). */
  ripe: number
  /** The farm is out of sight and was last tended long enough ago. */
  due: boolean
  /** Bread it may bake now (wheat beyond what it keeps for breeding). */
  bake: number
  /** A breeding pair and food for them are at hand. */
  canBreed: boolean
  /** The food source registry's choice (foodSourcePlan.ts); without it the old start_farm rule applies. */
  source?: Pick<FoodSourceChoice, 'active' | 'run' | 'kind'>
}

export interface FarmTaskOptions {
  tend: boolean
  tendRange: number
  minRipe: number
  bake: boolean
  breed: boolean
}

/** What farm_setup should do now, or null. Never at night, never while hungry (keep_fed's job). */
export function nextFarmTask (s: FarmState, o: FarmTaskOptions): FarmTask | null {
  if (s.night || s.hungry) return null
  if (!s.hasFarm) return s.source ? (s.source.active && s.source.run ? 'source' : null) : (s.canSetUp ? 'setup' : null)
  if (o.tend && s.farmDistance !== null && s.farmDistance <= o.tendRange && (s.ripe >= o.minRipe || s.due)) return 'tend'
  // a source before its farm in food.sources (repair a bad farm, a field farm while it only has the plot, fishing while stock is low)
  if (s.source?.active && s.source.run) return 'source'
  if (o.bake && s.bake > 0) return 'bake'
  if (o.breed && s.canBreed) return 'breed'
  return null
}

const options = z.object({
  place: z.string().optional().describe('remembered place to farm near; default home, else where it is'),
  size: z.number().int().min(3).max(9).default(9).describe('plot side around one water block'),
  radius: z.number().min(8).max(96).default(48).describe('how far from the centre to look for water'),
  fence: z.boolean().default(true).describe('fence the plot when it has the materials'),
  light: z.boolean().default(true).describe('put torches on the corners when it has torches or coal'),
  tend: z.boolean().default(true).describe('harvest and replant its farm when it is ripe'),
  tendRange: z.number().min(16).max(512).default(128).describe('only walk to the farm from this close'),
  tendMinutes: z.number().min(5).max(240).default(20).describe('check a farm that is out of sight this often'),
  minRipe: z.number().int().min(1).max(80).default(8).describe('harvest when at least this many crops are ripe'),
  bake: z.boolean().default(true).describe('bake bread from wheat'),
  breed: z.boolean().default(true).describe('breed animals it has food for (cows/sheep: wheat, pigs: carrots, chickens: seeds)'),
  keepWheat: z.number().int().min(0).max(64).default(4).describe('wheat to keep for breeding instead of baking'),
  maxHerd: z.number().int().min(2).max(64).default(12).describe('stop breeding a kind at this many adults'),
  spawnClearance: z.number().min(0).max(256).default(48).describe('never farm within this distance of the world spawn'),
  sources: z.boolean().default(true).describe('pick the food source from settings food.sources (repair, farm, plot, animals, fish, forage); off = only start_farm')
})

type O = z.infer<typeof options>

/** Night, or a thunderstorm (mobs spawn): the same test stay_safe uses, so far trips and night retreat never disagree. */
const nightNow = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 0; return (bot as { thunderState?: number }).thunderState! > 0 || (t >= 12_542 && t <= 23_459) }

function inv (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of bot.inventory?.items() ?? []) out[i.name] = (out[i.name] ?? 0) + i.count
  return out
}

/** Reads the world into a FarmState. */
export function senseFarm (agent: Agent, bot: Bot, o: O): FarmState {
  const items = inv(bot)
  const pos = bot.entity.position
  const farm = nearestFarm(agent, bot)
  const d = farm ? Math.hypot(farm.x - pos.x, farm.z - pos.z) : null
  const visible = !!farm && !!bot.blockAt?.(pos.offset(farm.x - pos.x, farm.y - pos.y, farm.z - pos.z))
  const ripe = farm && visible ? (ownFarmRipe(agent, bot, d! + 1)?.ripe ?? 0) : 0
  const grass = () => {
    const ids = ['short_grass', 'grass', 'tall_grass'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    return !!bot.findBlock?.({ matching: ids, maxDistance: 32 })
  }
  const food = typeof bot.food === 'number' ? bot.food : 20
  const health = typeof bot.health === 'number' ? bot.health : 20
  const breedKinds = Object.keys(BREED_FOOD)
  const canBreed = o.breed && !!agent.getAction('breed') &&
    !!breedPlan(animalsAround(agent, bot, pos, 24, breedKinds).adults, items, { maxHerd: o.maxHerd })
  return {
    night: nightNow(bot),
    hungry: isHungry(food, health, { below: 10, healBelow: 8 }),
    hasFarm: !!farm,
    canSetUp: !!agent.getAction('start_farm') && !!agent.canDig && (seedCount(items) > 0 || grass() || !!getHome(agent)),
    farmDistance: d === null ? null : Math.round(d),
    ripe,
    due: !!farm && !visible && Date.now() - (farm.tended ?? farm.created) >= o.tendMinutes * 60_000,
    bake: agent.getAction('craft') ? breadToBake(items.wheat ?? 0, o.breed ? o.keepWheat : 0) : 0,
    canBreed,
    ...(o.sources && foodSettings(agent).sources.length ? { source: foodSourceChoice(agent, bot) } : {})
  }
}

export const farmSetup = defineBehavior({
  name: 'farm_setup',
  capabilities: ['move', 'dig', 'place'],
  category: 'work',
  description: 'Makes the bot self-sufficient for food: when it has no farm it starts one (seeds from grass, a hoe, flat grass by water ' +
    'near home, outside protected areas and away from builds), then harvests and replants it when ripe, bakes bread from the ' +
    'wheat and breeds animals it has food for. By day only. Arm it on any bot that should feed itself long term.',
  options,
  requires: ['start_farm', 'harvest'],
  uses: ['craft', 'goto', 'breed', 'tend_farm'],
  needs: { dig: true },
  priority: 'npc',
  create (o, { agent }) {
    const opts = { tend: o.tend, tendRange: o.tendRange, minRipe: o.minRipe, bake: o.bake, breed: o.breed }
    return {
      cooldownMs: 30_000,
      failureCooldownMs: 120_000,
      maxFailureCooldownMs: 30 * 60_000,
      score ({ bot }) {
        if (!bot.entity || !needsSurvival(bot)) return 0 // creative: food doesn't matter
        switch (nextFarmTask(senseFarm(agent, bot, o), opts)) {
          case 'setup':
          case 'source': return 30
          case 'tend': return 28
          case 'bake': return 24
          case 'breed': return 22
          default: return 0
        }
      },
      async run (ctx) {
        const task = nextFarmTask(senseFarm(agent, ctx.bot, o), opts)
        switch (task) {
          case 'source': {
            const choice = foodSourceChoice(agent, ctx.bot)
            const r = await runFoodSource(ctx, choice, { ...(o.place ? { place: o.place } : {}), size: o.size, radius: o.radius, fence: o.fence, light: o.light, spawnClearance: o.spawnClearance })
            return { ...r, message: `${r.message} [${foodSourceText(choice)}]` }
          }
          case 'setup':
            return ctx.act('start_farm', {
              ...(o.place ? { place: o.place } : {}),
              size: o.size, radius: o.radius, fence: o.fence, light: o.light, spawnClearance: o.spawnClearance
            })
          case 'tend': {
            const farm = nearestFarm(agent, ctx.bot) as Farm
            const pos = ctx.bot.entity.position
            const far = Math.hypot(farm.x - pos.x, farm.z - pos.z)
            if (far > 8) {
              // a farm further than trips.minDistance is a trip: prepared, and back home when food or daylight runs short
              const there = await tripRun(ctx, { purpose: `a trip to ${farm.name}`, kind: 'food', distance: far }, () => ctx.act('goto', { x: farm.x, y: farm.y + 1, z: farm.z }))
              if (!there.ok) return { ok: false, message: `couldn't get to ${farm.name}: ${there.message}` }
            }
            saveFarm(agent, { ...farm, tended: Date.now() })
            const r = await ctx.act('harvest', { radius: Math.ceil((farm.size - 1) / 2 * 1.5) + 1, max: 81, x: farm.x, y: farm.y + 1, z: farm.z })
            // then the upkeep: bare farmland, trampled dirt, a ring more when there are seeds to spare
            const t = agent.getAction('tend_farm') ? await ctx.act('tend_farm', { farm: farm.name, size: o.size }) : null
            const upkeep = t?.ok ? `; ${t.message.replace(`${farm.name}: `, '')}` : ''
            // nothing ripe yet is not a failure: we checked
            return r.ok ? { ok: true, message: `${farm.name}: ${r.message}${upkeep}` } : { ok: true, message: `${farm.name}: nothing ripe yet${upkeep}` }
          }
          case 'bake': {
            const n = breadToBake(inv(ctx.bot).wheat ?? 0, o.breed ? o.keepWheat : 0)
            return ctx.act('craft', { item: 'bread', count: n })
          }
          case 'breed':
            return ctx.act('breed', { maxHerd: o.maxHerd })
          default: {
            const src = o.sources && foodSettings(agent).sources.length ? ` [${foodSourceText(foodSourceChoice(agent, ctx.bot))}]` : ''
            return { ok: false, message: `${getFarms(agent).length ? 'nothing to do on the farm' : 'no farm and no seeds or grass to start one'}${src}` }
          }
        }
      }
    }
  }
})
