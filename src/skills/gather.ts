import { defineSkill, defineAction, z, ok, fail, goals, goto, travel, checkAborted } from '../core/index.ts'
import { digBlock, DigRefusedError } from './world.ts'

/** A point just outside the protected zone the bot is in (or nearest), on the side it's already on. */
function exitPoint (agent: any, pos: { x: number, z: number }): { x: number, z: number } | null {
  const zones = agent.protectedAreas.zones as { x: number, z: number }[]
  if (!zones.length) return null
  const z = zones.reduce((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) <= Math.hypot(b.x - pos.x, b.z - pos.z) ? a : b)
  let dx = pos.x - z.x
  let dz = pos.z - z.z
  const len = Math.hypot(dx, dz) || 1
  if (len < 1) { dx = 1; dz = 0 }
  return { x: Math.round(z.x + (dx / len) * 32), z: Math.round(z.z + (dz / len) * 32) }
}

const collect = defineAction({
  name: 'collect',
  description: 'Mine a number of blocks of one type nearby and pick up the drops. Skips protected areas ' +
    '(spawn): if everything nearby is protected it walks out of the zone first. Needs digging enabled.',
  params: z.object({
    block: z.string().describe('block name, e.g. oak_log, dirt, cobblestone'),
    count: z.number().int().min(1).max(64).default(1)
  }),
  longRunning: false,
  async run ({ bot, agent, signal, log }, { block, count }) {
    if (!agent.canDig) return fail('digging is disabled for this bot')
    const type = bot.registry.blocksByName[block]
    if (!type) return fail(`unknown block ${block}`)
    const allowed = (p: { x: number, y: number, z: number }) => !agent.protectedAreas.isProtected(p)
    let got = 0
    let refusals = 0
    let leftZone = false
    while (got < count) {
      checkAborted(signal)
      const found = bot.findBlocks({ matching: type.id, maxDistance: 48, count: 64 })
      const target = found.map(p => bot.blockAt(p)).find(b => b && allowed(b.position))
      if (!target) {
        // Everything around is protected (or we're standing in a protected zone): walk out once and look again.
        const out = !leftZone && (found.length || agent.protectedAreas.isProtected(bot.entity.position)) ? exitPoint(agent, bot.entity.position) : null
        if (!out) break
        leftZone = true
        log.debug('leaving protected area to collect', { to: `${out.x} ${out.z}` })
        try { await travel(bot, out, signal, { range: 4 }) } catch (e) { checkAborted(signal); break }
        continue
      }
      try {
        await goto(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal)
        // Best tool for the block (axe for logs, pickaxe for stone...), if we have one.
        const tool = (bot.pathfinder as any).bestHarvestTool?.(target)
        if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
        await digBlock(bot, target, signal)
        got++
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) {
          // Remember the protected spot and keep looking elsewhere.
          agent.markProtected(target.position)
          if (++refusals >= 4) break
          continue
        }
        log.debug('collect stopped', { error: (e as Error).message })
        break
      }
    }
    const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    if (drop) await goto(bot, new goals.GoalBlock(drop.position.x, drop.position.y, drop.position.z), signal).catch(() => {})
    if (got) return ok(`collected ${got} ${block}${got < count ? ` (wanted ${count})` : ''}`)
    if (refusals) return fail(`every ${block} I tried is in a protected area; tell me where digging is allowed`)
    return fail(`no ${block} I'm allowed to dig within 48 blocks`)
  }
})

export const gather = () => defineSkill({
  name: 'gather',
  description: 'Mining and collecting blocks.',
  actions: [collect]
})
