import { defineSkill, defineAction, z, ok, fail, fmtPos } from '../core/index.ts'
import { vec, placeAt, findItem, reachBlock, digBlock, DigRefusedError } from './world.ts'

const placeBlock = defineAction({
  name: 'place_block',
  description: 'Place a block from the inventory at x y z. Needs a solid block next to that spot to build against.',
  params: z.object({
    item: z.string().describe('block item to place, e.g. cobblestone'),
    x: z.number(),
    y: z.number(),
    z: z.number()
  }),
  aliases: ['place'],
  async run ({ bot, signal }, { item, x, y, z: zz }) {
    if (!findItem(bot, item)) return fail(`no ${item} in inventory`)
    const pos = vec(bot, x, y, zz)
    try {
      await placeAt(bot, item, pos, signal)
    } catch (e) {
      if (signal.aborted) throw e
      return fail((e as Error).message)
    }
    return ok(`placed ${item} at ${fmtPos(pos)}`)
  }
})

const breakBlock = defineAction({
  name: 'break_block',
  description: 'Break (mine) the block at x y z with the best tool in the inventory. Needs digging enabled. ' +
    'Refuses chests and other containers unless force=true.',
  params: z.object({
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
    force: z.boolean().default(false).describe('also break containers (chests, barrels...)')
  }),
  async run ({ bot, agent, signal }, { x, y, z: zz, force }) {
    if (!agent.canDig) return fail('digging is disabled for this bot')
    const pos = vec(bot, x, y, zz)
    const block = bot.blockAt(pos)
    if (!block || block.name === 'air' || block.name === 'cave_air') return fail(`nothing to break at ${fmtPos(pos)}`)
    if (block.name === 'bedrock' || block.hardness === null || block.hardness < 0) return fail(`${block.name} can't be broken`)
    if (!force && /chest|barrel|shulker_box|furnace|hopper|dispenser|dropper/.test(block.name)) return fail(`${block.name} looks like storage; pass force=true to break it`)
    await reachBlock(bot, pos, signal)
    const tool = (bot.pathfinder as any).bestHarvestTool?.(block)
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    try {
      await digBlock(bot, block, signal)
    } catch (e) {
      if (e instanceof DigRefusedError) return fail(e.message)
      throw e
    }
    return ok(`broke ${block.name} at ${fmtPos(pos)}`)
  }
})

export const building = () => defineSkill({
  name: 'building',
  description: 'Placing blocks.',
  actions: [placeBlock, breakBlock]
})
