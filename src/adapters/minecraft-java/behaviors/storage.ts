// check_storage: by day, now and then, looks into its own and configured chests near home that
// it has not seen inside for settings.inventoryMemory.refreshMinutes (the check_chests action), so
// container memory stays right while players take things, and tells the owners when the pantry
// runs low. Runs only with inventoryMemory.enabled and indexOwn on; low priority (below food,
// safety, tools and lighting).
import type { Bot } from 'mineflayer'
import { z, needsSurvival, type Agent } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { helpDesk } from '../../../brains/npc/help.ts'
import { memoryOptions, storageDue } from '../../../skills/containers.ts'
import { isDay } from './util.ts'

const LOW_KEY = 'containers.lowReported'
/** The pantry-low message at most this often (the help desk adds its own limits). */
export const LOW_EVERY_MS = 6 * 3_600_000

/** Whether to tell the owners the pantry is low: not more than every LOW_EVERY_MS, and again sooner only when it dropped further. Pure. */
export function lowReportDue (last: { at: number, items: number } | undefined, items: number, now: number): boolean {
  if (!last) return true
  if (now - last.at >= LOW_EVERY_MS) return true
  return items < last.items && items === 0
}

function reportLow (agent: Agent, low: { items: number, text: string }, now: number): void {
  const last = agent.storage.get<{ at: number, items: number } | undefined>(LOW_KEY)
  if (!lowReportDue(last, low.items, now)) return
  const asked = helpDesk(agent).ask({ behavior: 'pantry', reason: 'pantry low', key: 'pantry low', goal: 'keep the pantry stocked', help: 'some food in the pantry', text: low.text }, now)
  if (asked) agent.storage.set(LOW_KEY, { at: now, items: low.items })
  else agent.log.info(`check_storage: ${low.text} (not told: nobody online or rate limited)`)
}

export const checkStorage = defineBehavior({
  name: 'check_storage',
  capabilities: ['move', 'containers'],
  category: 'work',
  description: 'Keeps container memory right: by day, when settings.inventoryMemory has enabled and indexOwn on, every refreshMinutes it walks to its own ' +
    'and configured chests near home that it has not looked into lately and looks inside (check_chests), noting items taken or added and chests ' +
    'moved or broken; tells the owners when the pantry runs low ("pantry low: 6 bread left"), at most every 6 hours. Never opens anyone else\'s chest. ' +
    'Low priority: after food, safety, tools and lighting.',
  options: z.object({
    max: z.number().int().min(1).max(8).default(3).describe('chests to look into per run'),
    maxTrip: z.number().int().min(16).max(512).default(96).describe('only when the bot is within this distance of home')
  }),
  requires: ['check_chests'],
  priority: 'npc',
  create (o, { agent }) {
    const due = (bot: Bot, now: number) => storageDue(agent, bot, memoryOptions(agent).radius, now)
    const nearHome = (bot: Bot) => {
      const h = agent.storage.get<{ x: number, z: number } | undefined>('home')
      return !h || Math.hypot(h.x - bot.entity.position.x, h.z - bot.entity.position.z) <= o.maxTrip
    }
    return {
      cooldownMs: 60_000,
      failureCooldownMs: 10 * 60_000,
      maxFailureCooldownMs: 2 * 60 * 60_000,
      score: ({ bot, now, current }) => {
        const b = bot as Bot
        const m = memoryOptions(agent)
        if (!m.enabled || !m.indexOwn || !b.entity || !needsSurvival(b) || !isDay(b)) return 0
        if (current === 'check_storage') return 14
        return nearHome(b) && due(b, now).length ? 14 : 0
      },
      async run (ctx) {
        const m = memoryOptions(agent)
        const r = await ctx.act('check_chests', { radius: m.radius, max: o.max })
        const low = (r.data as { low?: { items: number, text: string } | null } | undefined)?.low
        if (low) reportLow(agent, low, Date.now())
        agent.log.info(`check_storage: ${r.message}`)
        return r
      }
    }
  }
})
