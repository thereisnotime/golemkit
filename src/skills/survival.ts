import type { Bot } from 'mineflayer'
import { defineSkill, defineAction, noParams, ok, fail, goals, goto } from '../core/index.ts'

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

export const survival = () => defineSkill({
  name: 'survival',
  description: 'Eating and sleeping.',
  actions: [eat, sleepInBed, wake],
  observe: (_agent, bot) => ({ hasFood: !!bestFood(bot), sleeping: bot.isSleeping })
})
