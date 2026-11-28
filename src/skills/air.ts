// The `air` action: the drowning reflex (brains/reflexes.ts starts it, reflexPlan.ts keeps
// everything but water_bucket from interrupting it). Gets air the cheapest way (airPlan.ts:
// straight up, break ice or a roof above, swim to an opening), then gets out of the water: onto a
// ledge beside it, out of a shaft whose rim is too high (shaftExit: raise the floor, pillar up, or
// dig a step into the wall), or swims to dry land. Air always comes first: whenever it runs low
// again on the way out, it goes back up for air.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { defineAction, z, ok, fail, getAir, headInWater, oxygen, fmtPos, climbOntoLedge, airCells, sleep, checkAborted } from '../core/index.ts'
import { boxedIn, shaftExit, airSettings, noteAirRun, type V, type AirRun } from './airPlan.ts'
import { reachDryLand } from './navigation.ts'
import { fillerBlock, pillarUp, climbOutNow } from './survival.ts'

/** On the way out, back for air below this (of 20). */
const LOW_ON_THE_WAY = 12

/** Recent air runs per bot, for loop detection (airPlan.noteAirRun). */
const runs = new WeakMap<object, AirRun[]>()

export const air = defineAction({
  name: 'air',
  capabilities: ['move'],
  description: 'Get air when drowning: swim up, break ice or a roof above the head, or swim to the nearest opening, then get out of the water (climb a ledge, build or dig out of a shaft, or swim to dry land) (used by reflexes).',
  params: z.object({
    land: z.boolean().default(true).describe('get out of the water afterwards')
  }),
  internal: true,
  async run (ctx, { land }) {
    const { agent, bot, signal, log } = ctx
    // the action's logger: the plan of every re-plan goes to the debug log
    const opts = { canDig: agent.canDig, isProtected: (p: V) => agent.protectedAreas.isProtected(p), log: (m: string) => log.debug(m) }
    const notes: string[] = []
    const st = airSettings(agent.settings.reflexes as Parameters<typeof airSettings>[0])
    const here = bot.entity.position
    const noted = noteAirRun(runs.get(bot) ?? [], { at: Date.now(), x: here.x, y: here.y, z: here.z }, st)
    runs.set(bot, noted.history)
    for (let round = 0; round < 4; round++) {
      const r = await getAir(bot, signal, opts)
      notes.push(r.summary)
      agent.log.info(r.summary)
      if (!r.ok) return fail(`${notes.join('; ')} at ${fmtPos(bot.entity.position)}`)
      if (!land) break
      // the same spot again and again: getting air here leads back under, dig out to the sky
      if (noted.loop && agent.canDig) {
        const out = await climbOutNow(ctx, 48).catch(e => { checkAborted(signal); return fail((e as Error).message) })
        agent.log.info(`air: ${st.loopRuns}+ air runs here in ${st.loopMinutes} min, digging out to the sky: ${out.message}`)
        if (out.ok) { notes.push('dug out to the sky (kept coming back for air here)'); runs.set(bot, []); break }
        notes.push(`couldn't dig out: ${out.message}`)
      }
      // onto the edge right beside it (a hole in the ice)
      if (await climbOntoLedge(bot, signal)) { notes.push('climbed out'); break }
      // a flooded shaft with the rim out of reach: build or dig a way up, back for air when low
      const feet = bot.entity.position.floored()
      if (boxedIn(feet, airCells(bot, opts))) {
        const out = await escapeShaft(bot, signal, opts, m => log.debug(m))
        if (out === 'out') { notes.push('climbed out of the shaft'); break }
        if (out === 'low') { notes.push('back for air'); continue }
        notes.push(out)
      }
      // else to dry land, but back for air if it runs low on the way (the pathfinder walks lake beds)
      const low = new AbortController()
      const watch = setInterval(() => { if (headInWater(bot) && oxygen(bot) < LOW_ON_THE_WAY) low.abort() }, 250)
      let dry = false
      try {
        // out to reflexes.airShoreRadius: in the middle of a lake 12 blocks found nothing and it bobbed up and down for minutes
        dry = await reachDryLand(bot, AbortSignal.any([signal, low.signal]), st.shoreRadius)
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

/**
 * Out of a pit or shaft whose rim is too high to climb from the water, one shaftExit step at a
 * time. 'out' when it stands on the ledge, 'low' when the air runs low again (go back for air
 * first), else why it stopped.
 */
export async function escapeShaft (bot: Bot, signal: AbortSignal, opts: NonNullable<Parameters<typeof airCells>[1]>, log: (m: string) => void): Promise<'out' | 'low' | string> {
  let fails = 0
  let last = ''
  for (let i = 0; i < 16 && fails < 3; i++) {
    checkAborted(signal)
    if (headInWater(bot) && oxygen(bot) < LOW_ON_THE_WAY) return 'low'
    const feet = bot.entity.position.floored()
    const block = fillerBlock(bot)
    const step = shaftExit({ feet: { x: feet.x, y: feet.y, z: feet.z }, cell: airCells(bot, opts), blocks: !!block })
    const said = `shaft at ${feet.x} ${feet.y} ${feet.z}: ${step.act}: ${step.why}`
    if (said !== last) { log(said); last = said }
    try {
      if (step.act === 'out') return 'out'
      if (step.act === 'none') return `stuck in the shaft: ${step.why}`
      if (step.act === 'ledge') {
        // onto it, then on up from there (a step dug into the wall is still below the rim)
        if (await climbOntoLedge(bot, signal)) fails = 0
        else fails++
        continue
      }
      if (step.act === 'pillar' && block) {
        if (await pillarUp(bot, signal, block, 1)) fails = 0
        else fails++
        continue
      }
      if (step.act === 'fill' && block) {
        // afloat: keep swimming up so the bot doesn't sink into the cell it fills
        bot.setControlState('jump', true)
        const it = bot.inventory.items().find(x => x.name === block)
        if (it) await bot.equip(it, 'hand')
        const floor = bot.blockAt(new Vec3(step.at.x, step.at.y - 1, step.at.z))
        if (!floor) { fails++; continue }
        try {
          await bot.placeBlock(floor, new Vec3(0, 1, 0))
          fails = 0
        } catch (e) {
          checkAborted(signal)
          if (bot.blockAt(new Vec3(step.at.x, step.at.y, step.at.z))?.boundingBox === 'block') fails = 0
          else { fails++; log(`shaft: could not place ${block} at ${step.at.x} ${step.at.y} ${step.at.z}: ${(e as Error).message}`) }
        }
        await sleep(200, signal)
        continue
      }
      if (step.act === 'notch' || step.act === 'clear') {
        if (opts.canDig === false) return 'stuck in the shaft: may not dig'
        // afloat: keep swimming to stay at the surface; on the floor: stand still (a dig off the ground is 5x slower)
        const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
        bot.setControlState('jump', !(floor && floor.boundingBox === 'block'))
        for (const p of step.act === 'clear' ? [step.dig] : step.dig) {
          checkAborted(signal)
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
          if (!b || b.boundingBox !== 'block') continue
          const tool = (bot.pathfinder as any)?.bestHarvestTool?.(b)
          if (tool) await bot.equip(tool, 'hand').catch(() => {})
          await bot.dig(b, true)
          if (headInWater(bot) && oxygen(bot) < LOW_ON_THE_WAY) return 'low'
        }
        if (step.act === 'clear') { fails = 0; continue }
        if (await climbOntoLedge(bot, signal)) fails = 0
        else fails++
        continue
      }
      fails++
    } catch (e) {
      checkAborted(signal)
      log(`shaft: ${step.act} failed: ${(e as Error).message}`)
      fails++
    } finally {
      bot.setControlState('jump', false)
    }
  }
  return 'stuck in the shaft'
}
