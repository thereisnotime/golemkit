import { defineSkill, defineAction, z, ok, fail, fmtPos } from '../core/index.ts'
import { vec, placeAt, findItem } from './world.ts'

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

export const building = () => defineSkill({
  name: 'building',
  description: 'Placing blocks.',
  actions: [placeBlock]
})
