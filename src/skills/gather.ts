import { defineSkill, defineAction, z, ok, fail, goals, goto, checkAborted } from '../core/index.ts'
import { digBlock, DigRefusedError } from './world.ts'

const collect = defineAction({
  name: 'collect',
  description: 'Mine a number of blocks of one type nearby and pick up the drops. Needs digging enabled.',
  params: z.object({
    block: z.string().describe('block name, e.g. oak_log'),
    count: z.number().int().min(1).max(64).default(1)
  }),
  async run ({ bot, agent, signal, log }, { block, count }) {
    if (!agent.canDig) return fail('digging is disabled for this bot')
    const type = bot.registry.blocksByName[block]
    if (!type) return fail(`unknown block ${block}`)
    let got = 0
    while (got < count) {
      checkAborted(signal)
      const target = bot.findBlock({ matching: type.id, maxDistance: 32 })
      if (!target) break
      try {
        await goto(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal)
        await digBlock(bot, target, signal)
        got++
      } catch (e) {
        checkAborted(signal)
        // Refused breaks (spawn protection, claims) leave the block in place; say so instead of looping.
        if (e instanceof DigRefusedError) return got ? ok(`collected ${got} ${block}, then hit a protected area`) : fail(e.message)
        log.debug('collect stopped', { error: (e as Error).message })
        break
      }
    }
    const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    if (drop) await goto(bot, new goals.GoalBlock(drop.position.x, drop.position.y, drop.position.z), signal).catch(() => {})
    return got ? ok(`collected ${got} ${block}`) : fail(`no ${block} nearby`)
  }
})

export const gather = () => defineSkill({
  name: 'gather',
  description: 'Mining and collecting blocks.',
  actions: [collect]
})
