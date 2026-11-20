import { defineSkill, defineAction, z, noParams, ok, fail, playerEntity, itemName } from '../core/index.ts'

const inventory = defineAction({
  name: 'inventory',
  description: 'List what the bot is carrying.',
  params: noParams,
  exclusive: false,
  aliases: ['inv'],
  run ({ bot }) {
    const counts: Record<string, number> = {}
    for (const i of bot.inventory.items()) counts[itemName(i)] = (counts[itemName(i)] ?? 0) + i.count
    const entries = Object.entries(counts)
    if (!entries.length) return ok('inventory is empty', counts)
    return ok(entries.map(([n, c]) => `${c}x ${n}`).join(', '), counts)
  }
})

const drop = defineAction({
  name: 'drop',
  description: 'Throw items towards the requesting player (or on the ground). item="all" drops everything.',
  params: z.object({
    item: z.string().default('all').describe('item name, or "all"'),
    count: z.number().int().positive().optional().describe('how many; default the whole stack(s)')
  }),
  async run ({ bot, player }, { item, count }) {
    const target = playerEntity(bot, player)
    if (target) await bot.lookAt(target.position.offset(0, 1.6, 0)).catch(() => {})
    const items = bot.inventory.items().filter(i => item === 'all' || itemName(i) === item)
    if (!items.length) return fail(`no ${item}`)
    let left = count ?? Infinity
    for (const i of items) {
      if (left <= 0) break
      const n = Math.min(i.count, left)
      if (n === i.count) await bot.tossStack(i)
      else await bot.toss(i.type, null, n)
      left -= n
    }
    return ok('dropped')
  }
})

const equip = defineAction({
  name: 'equip',
  description: 'Hold an item in the main hand.',
  params: z.object({ item: z.string() }),
  async run ({ bot }, { item }) {
    const it = bot.inventory.items().find(i => itemName(i) === item)
    if (!it) return fail(`no ${item}`)
    await bot.equip(it, 'hand')
    return ok(`holding ${item}`)
  }
})

export const inventorySkill = () => defineSkill({
  name: 'inventory',
  description: 'Inventory management.',
  actions: [inventory, drop, equip]
})
