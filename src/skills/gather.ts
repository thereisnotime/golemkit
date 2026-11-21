import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, goals, goto, travel, checkAborted } from '../core/index.ts'
import { digBlock, DigRefusedError, gotoWithin } from './world.ts'
import { ensureTool, equipFor, minTierFor, needsTool, toolKindFor } from './toolkit.ts'

/** A point 32 blocks outside the nearest protected zone, on the bot's side of it. */
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

/**
 * Mines up to `count` blocks of one type nearby and walks over the drops (the collect
 * action's body, reused by gather_materials). Skips protected areas, walking out of the zone
 * once if everything nearby is protected. Blocks that drop nothing by hand (stone, ores) get
 * a pickaxe of the right tier first, crafted if the inventory allows.
 */
export async function collectBlocks ({ bot, agent, signal, log }: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, block: string, count: number): Promise<ActionResult> {
  if (!agent.canDig) return fail('digging is disabled for this bot')
  const type = bot.registry.blocksByName[block]
  if (!type) return fail(`unknown block ${block}`)
  // Things you get from a different block in the world: cobblestone from stone, dirt from grass.
  const SOURCES: Record<string, string[]> = {
    cobblestone: ['stone', 'cobblestone'],
    cobbled_deepslate: ['deepslate', 'cobbled_deepslate'],
    dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'],
    flint: ['gravel'],
    clay_ball: ['clay'],
    sand: ['sand'],
    gravel: ['gravel']
  }
  const matchIds = (SOURCES[block] ?? [block]).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  let toolNote = ''
  if (needsTool(type)) {
    const kind = toolKindFor(type) ?? 'pickaxe'
    const tool = await ensureTool(bot, signal, kind, { minTier: minTierFor(bot.registry, type) })
    if (!tool.ok) return fail(`${block} needs a ${kind}: ${tool.message}`)
    if ((tool.data as { crafted?: boolean } | undefined)?.crafted) toolNote = `${tool.message}, `
  }
  const skip = new Set<string>()
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const allowed = (p: { x: number, y: number, z: number }) => !agent.protectedAreas.isProtected(p) && !skip.has(key(p))
  let got = 0
  let refusals = 0
  let misses = 0
  let leftZone = false
  while (got < count && misses < 3) {
    checkAborted(signal)
    const found = bot.findBlocks({ matching: matchIds, maxDistance: 48, count: 64 })
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
      await gotoWithin(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal, 20_000)
      await equipFor(bot, target) // best tool for the block (axe for logs, pickaxe for stone...)
      await digBlock(bot, target, signal)
      got++
      misses = 0
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) {
        // Remember the protected spot and keep looking elsewhere.
        agent.markProtected(target.position)
        if (++refusals >= 4) break
        continue
      }
      log.debug('collect: skipping a block', { error: (e as Error).message })
      skip.add(key(target.position))
      misses++
    }
  }
  const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
  if (drop) await goto(bot, new goals.GoalBlock(drop.position.x, drop.position.y, drop.position.z), signal).catch(() => {})
  if (got) return ok(`${toolNote}collected ${got} ${block}${got < count ? ` (wanted ${count})` : ''}`)
  if (refusals) return fail(`every ${block} I tried is in a protected area; tell me where digging is allowed`)
  return fail(`no ${block} I'm allowed to dig within 48 blocks`)
}

const collect = defineAction({
  name: 'collect',
  description: 'Mine a number of blocks of one type nearby and pick up the drops, with the right tool (crafts a pickaxe first for stone and ores when it can). ' +
    'Skips protected areas (spawn): if everything nearby is protected it walks out of the zone first. Needs digging enabled.',
  params: z.object({
    block: z.string().describe('block name, e.g. oak_log, dirt, stone, cobblestone'),
    count: z.number().int().min(1).max(64).default(1)
  }),
  longRunning: false,
  run: (ctx, { block, count }) => collectBlocks(ctx, block, count)
})

export const gather = () => defineSkill({
  name: 'gather',
  description: 'Mining and collecting blocks.',
  actions: [collect]
})
