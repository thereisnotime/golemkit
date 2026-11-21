import type { Bot } from 'mineflayer'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, goto, fmtPos, sleep, checkAborted, itemName } from '../core/index.ts'
import { findItem } from './world.ts'

/** Cheap full blocks that don't fall, for pillars and emergency shelters. */
const FILLER = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone|.*_planks)$/

/** The most plentiful cheap filler block in the inventory, or null. */
export function fillerBlock (bot: Bot): string | null {
  const it = bot.inventory.items().filter(i => FILLER.test(itemName(i))).sort((a, b) => b.count - a.count)[0]
  return it ? itemName(it) : null
}

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

export function bestFood (bot: Bot) {
  const foods = (bot.registry as any).foodsByName ?? {}
  return bot.inventory.items()
    .filter(i => foods[i.name] && !BAD_FOOD.has(i.name))
    .sort((a, b) => (foods[b.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0))[0]
}

const eat = defineAction({
  name: 'eat',
  description: 'Eat the best food in the inventory.',
  params: noParams,
  async run ({ bot }) {
    if (bot.food >= 20) return fail('not hungry')
    const food = bestFood(bot)
    if (!food) return fail('nothing to eat')
    await bot.equip(food, 'hand')
    await bot.consume()
    return ok(`ate ${food.name}, food ${bot.food}/20`)
  }
})

const sleepInBed = defineAction({
  name: 'sleep',
  description: 'Sleep in a bed within 16 blocks (only works at night or during storms).',
  params: noParams,
  async run ({ bot, signal }) {
    const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 16 })
    if (!bed) return fail('no bed nearby')
    await goto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), signal)
    await bot.sleep(bed)
    return ok('sleeping')
  }
})

const wake = defineAction({
  name: 'wake',
  description: 'Get out of bed.',
  params: noParams,
  async run ({ bot }) {
    if (!bot.isSleeping) return fail('not sleeping')
    await bot.wake()
    return ok('awake')
  }
})

const pillar = defineAction({
  name: 'pillar',
  description: 'Emergency escape: jump and place blocks underneath to stand on a pillar out of reach of mobs. ' +
    'Uses dirt/cobblestone/planks from the inventory.',
  params: z.object({
    height: z.number().int().min(1).max(8).default(3).describe('how many blocks to rise'),
    item: z.string().optional().describe('block to use; default the most plentiful dirt/cobblestone/planks')
  }),
  async run ({ bot, agent, signal }, { height, item }) {
    const block = item ?? fillerBlock(bot)
    if (!block || !findItem(bot, block)) return fail(item ? `no ${item}` : 'no dirt, cobblestone or planks to pillar with')
    if (agent.protectedAreas.isProtected(bot.entity.position)) return fail('can\'t build here (protected area)')
    const at = (dy: number) => bot.blockAt(bot.entity.position.floored().offset(0, dy, 0))
    const up = bot.entity.position.floored().scaled(0).offset(0, 1, 0)
    let placed = 0
    try {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      for (let i = 0; i < height; i++) {
        checkAborted(signal)
        if (at(2)?.boundingBox !== 'empty') break // ceiling
        const it = findItem(bot, block)
        if (!it) break
        await bot.equip(it, 'hand')
        const ground = at(-1)
        if (!ground || ground.boundingBox !== 'block') break
        const floorY = Math.floor(bot.entity.position.y)
        bot.setControlState('jump', true)
        const until = Date.now() + 1500
        while (bot.entity.position.y < floorY + 1.05 && Date.now() < until) await sleep(50, signal)
        try {
          await bot.placeBlock(ground, up)
          placed++
        } catch {
          await sleep(200, signal)
          if (bot.blockAt(ground.position.offset(0, 1, 0))?.boundingBox === 'block') placed++
          else break
        } finally {
          bot.setControlState('jump', false)
        }
        await sleep(250, signal)
      }
    } finally {
      bot.setControlState('jump', false)
    }
    return placed
      ? ok(`pillared up ${placed} block${placed === 1 ? '' : 's'} with ${block}, at ${fmtPos(bot.entity.position)}`)
      : fail('could not build a pillar here')
  }
})

export const survival = () => defineSkill({
  name: 'survival',
  description: 'Eating, sleeping and emergency pillars.',
  actions: [eat, sleepInBed, wake, pillar],
  observe: (_agent, bot) => ({ hasFood: !!bestFood(bot), sleeping: bot.isSleeping })
})
