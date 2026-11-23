import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, goals, goto, travel, checkAborted } from '../core/index.ts'
import { digBlock, DigRefusedError, gotoWithin } from './world.ts'
import { ensureTool, equipFor, minTierFor, needsTool, toolKindFor, harvestProblem, dropWatch } from './toolkit.ts'
import { pickupNearby } from './pickup.ts'
import { mineStone, miningState, depthOk, undergroundNow } from './mining.ts'
import { notReadyText, undergroundRetreat } from './minePlan.ts'
import { climbOut } from './survival.ts'
import { autoUpgrade } from './progression.ts'
import { perMinute } from './efficiency.ts'

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
export async function collectBlocks ({ bot, agent, signal, log }: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, block: string, count: number, opts: { safe?: boolean } = {}): Promise<ActionResult> {
  if (!agent.canDig) return fail('digging is disabled for this bot')
  const type = bot.registry.blocksByName[block]
  if (!type) return fail(`unknown block ${block}`)
  // Stone: a safe staircase/strip mine beats pathing to buried blocks (and stone tools first).
  if ((block === 'cobblestone' || block === 'stone') && count > 2) {
    const up = await autoUpgrade({ bot, agent, signal, log })
    const r = await mineStone({ bot, agent, signal, log }, count, block === 'stone' ? { item: 'cobblestone' } : {})
    return up ? { ...r, message: `${up}${r.message}` } : r
  }
  // Things you get from a different block in the world: cobblestone from stone, dirt from grass.
  const SOURCES: Record<string, string[]> = {
    cobblestone: ['stone'], // never placed cobblestone: that is somebody's build
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
  let nothing = '' // digging that gives nothing: why
  const watch = dropWatch(bot)
  // safe mining: not ready (weapon, food, gear) means nothing deeper than mining.safeDepth (no cave trips)
  const m0 = miningState(bot, agent.settings)
  const mining = opts.safe === false ? { ...m0, s: { ...m0.s, safe: false } } : m0
  let tooDeep = 0
  let refusals = 0
  let misses = 0
  let leftZone = false
  const t0 = Date.now()
  let retreat = ''
  while (got < count && misses < 3) {
    checkAborted(signal)
    // safe mining: losing underground (health, hostiles, air) ends the job and the bot climbs out
    if (mining.s.safe) {
      const why = undergroundRetreat({ ...undergroundNow(bot, mining.s.hostileRadius), health: bot.health }, mining.s)
      if (why) { retreat = why; break }
    }
    const found = bot.findBlocks({ matching: matchIds, maxDistance: 48, count: 256 })
    // Cheapest first: blocks already in reach at or above our feet (no pathing at all), then exposed ones (air next to them: reachable without long dig-paths), then buried.
    const near = found.map(p => bot.blockAt(p)).filter((b): b is NonNullable<typeof b> => !!b && allowed(b.position))
    const candidates = near.filter(b => depthOk(bot, mining, b.position))
    tooDeep = near.length - candidates.length
    const exposed = (b: { position: any }) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => { const n = bot.blockAt(b.position.offset(dx, dy, dz)); return !n || n.boundingBox === 'empty' })
    const feetY = Math.floor(bot.entity.position.y)
    // Never pick blocks below our feet as "in reach": that digs a shaft straight down (caves, lava).
    const target = candidates.find(b => b.position.y >= feetY && bot.canDigBlock(b) && b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.6, 0)) <= 4.5) ??
      candidates.find(exposed) ?? candidates[0]
    if (!target) {
      // Everything around is protected (or we're standing in a protected zone): walk out once and look again.
      const out = !leftZone && (found.length > tooDeep || agent.protectedAreas.isProtected(bot.entity.position)) ? exitPoint(agent, bot.entity.position) : null
      if (!out) break
      leftZone = true
      log.debug('leaving protected area to collect', { to: `${out.x} ${out.z}` })
      try { await travel(bot, out, signal, { range: 4 }) } catch (e) { checkAborted(signal); break }
      continue
    }
    try {
      const inReach = bot.canDigBlock(target) && target.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.6, 0)) <= 4.5
      if (!inReach) await gotoWithin(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal, 20_000)
      await equipFor(bot, target) // best tool for the block (axe for logs, pickaxe for stone...)
      const noTool = harvestProblem(bot, target)
      if (noTool) { nothing = noTool; break }
      await digBlock(bot, target, signal)
      got++
      misses = 0
      const why = watch.dug(target)
      if (why) {
        if (/lying around/.test(why)) await pickupNearby(bot, signal, { radius: 8, maxMs: 8000 })
        if (!/lying around/.test(why) || !watch.recheck()) { nothing = why; break }
      }
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
  if (retreat) {
    log.info('collect: abandoned underground', { why: retreat, at: `${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}` })
    const up = await (climbOut as any).run({ bot, agent, signal, log }, { maxBlocks: 64 }).catch((e: Error) => { checkAborted(signal); return fail(e.message) }) as ActionResult
    return fail(`abandoned collecting ${block} (${got} got): ${retreat}; ${up.ok ? up.message : `climbing out failed: ${up.message}`}`, { retreat, got })
  }
  // every drop, not just the nearest one: blocks dug from a distance leave their item behind
  const picked = got ? await pickupNearby(bot, signal, { radius: 10, maxMs: 12_000 }).catch(e => { checkAborted(signal); return 0 }) : 0
  const rate = got ? `, ${perMinute(got, Date.now() - t0)}/min` : ''
  log.debug('collected', { block, got, picked, perMin: perMinute(got, Date.now() - t0) })
  if (got) return ok(`${toolNote}collected ${got} ${block}${got < count ? ` (wanted ${count})` : ''}${rate}`)
  if (refusals) return fail(`every ${block} I tried is in a protected area; tell me where digging is allowed`)
  if (tooDeep && !skip.size) return fail(`${block} only deeper than ${mining.s.safeDepth} blocks below the surface (${tooDeep} seen) and ${notReadyText(mining.readiness)}`, { notReady: true, need: mining.readiness.need })
  if (skip.size) return fail(`found ${block} but couldn't get to any of it (${skip.size} tried: paths timed out or blocked); try from another spot`)
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
  capabilities: ['move', 'dig'],
  description: 'Mining and collecting blocks.',
  actions: [collect]
})
