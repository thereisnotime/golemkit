// The `air` action: the drowning reflex (brains/reflexes.ts starts it, reflexPlan.ts keeps
// everything but water_bucket from interrupting it). Gets air the cheapest way (airPlan.ts:
// straight up, break ice or a roof above, swim to an opening), then swims to dry land so the
// bot doesn't sink again once it stops swimming.
import { defineAction, z, ok, fail, getAir, headInWater, oxygen, fmtPos, climbOntoLedge } from '../core/index.ts'
import { reachDryLand } from './navigation.ts'

export const air = defineAction({
  name: 'air',
  capabilities: ['move'],
  description: 'Get air when drowning: swim up, break ice or a roof above the head, or swim to the nearest opening, then get to dry land (used by reflexes).',
  params: z.object({
    land: z.boolean().default(true).describe('swim to dry land afterwards')
  }),
  internal: true,
  async run ({ agent, bot, signal }, { land }) {
    const opts = { canDig: agent.canDig, isProtected: (p: { x: number, y: number, z: number }) => agent.protectedAreas.isProtected(p), log: (m: string) => agent.log.debug(m) }
    const notes: string[] = []
    for (let round = 0; round < 3; round++) {
      const r = await getAir(bot, signal, opts)
      notes.push(r.summary)
      agent.log.info(r.summary)
      if (!r.ok) return fail(`${notes.join('; ')} at ${fmtPos(bot.entity.position)}`)
      if (!land) break
      // onto the edge right beside it (a hole in the ice), else to dry land, but back for air if it
      // runs low on the way (the pathfinder walks lake beds)
      if (await climbOntoLedge(bot, signal)) { notes.push('climbed out'); break }
      const low = new AbortController()
      const watch = setInterval(() => { if (headInWater(bot) && oxygen(bot) < 12) low.abort() }, 250)
      let dry = false
      try {
        dry = await reachDryLand(bot, AbortSignal.any([signal, low.signal]))
      } catch (e) {
        if (signal.aborted || !low.signal.aborted) throw e
      } finally {
        clearInterval(watch)
      }
      if (dry) { notes.push('on dry land'); break }
      if (!low.signal.aborted) { notes.push('no dry land close by'); break }
    }
    return ok(`${notes.join('; ')} at ${fmtPos(bot.entity.position)}`)
  }
})
