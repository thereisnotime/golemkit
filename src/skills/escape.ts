// Runs the escape routes retreatPlan.ts picks (ESCAPE_ROUTES, settings.retreat.routes) and the
// recovery after them: go home (and shut the door), pillar up and hit down, bunker, sprint
// away; then eat and wait to heal (recoverStep), and tell defend whether to come back. Each
// route is one executor in ROUTE_RUNNERS, so a new one is a planner entry plus a function here.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { ActionContext } from '../core/index.ts'
import { fmtPos, sleep, checkAborted } from '../core/index.ts'
import { fightTarget, eatNow, fightFood, eyeReach, safeStep, clearMoves } from './fight.ts'
import { fillerBlock, bestFood, roofAbove } from './survival.ts'
import { getHome, homeOffset, sameDimension } from './navigation.ts'
import { weaponFlags } from './weapons.ts'
import { threatsAround, noteRetreat } from './retreat.ts'
import { ESCAPE_ROUTES, planEscape, homeThroughThreats, recoverStep, type EscapeInput, type RetreatSettings, type RouteId } from './retreatPlan.ts'

/** Runs another action's body inline (agent.act from inside an action would preempt this one). */
export async function runInline (ctx: ActionContext, name: string, params: Record<string, unknown>): Promise<{ ok: boolean, message: string } | null> {
  const def = ctx.agent.getAction(name)
  if (!def) return null
  const r = await def.run(ctx, def.params.parse(params))
  if (r === undefined) return { ok: true, message: 'done' }
  return typeof r === 'string' ? { ok: true, message: r } : r
}

const HAND_DROPS = /^(dirt|grass_block|coarse_dirt|rooted_dirt|mud|clay|sand|red_sand|snow_block|podzol|mycelium)$/

function freeAbove (bot: Bot, max = 4): number {
  const p = bot.entity.position.floored()
  for (let dy = 2; dy < 2 + max; dy++) if (bot.blockAt(p.offset(0, dy, 0))?.boundingBox !== 'empty') return dy - 2
  return max
}

/** What the routes look at, read off the world. */
export function escapeInputs (ctx: ActionContext, s: RetreatSettings): EscapeInput {
  const { bot, agent } = ctx
  const me = bot.entity.position
  const threats = threatsAround(bot, 16)
  const home = getHome(agent)
  const rel = (p: { x: number, z: number }) => ({ x: p.x - me.x, z: p.z - me.z })
  const filler = fillerBlock(bot)
  const blocks = filler ? bot.inventory.items().filter(i => i.name === filler).reduce((n, i) => n + i.count, 0) : 0
  const floor = bot.blockAt(me.floored().offset(0, -1, 0))?.name ?? ''
  const feet = bot.blockAt(me.floored())?.name ?? ''
  return {
    home: home && sameDimension(bot, home) ? { dist: homeOffset(me, home), throughThreats: homeThroughThreats(rel(home), threats.filter(t => t.dist <= 12).map(t => rel(t.pos))) } : null,
    canPlace: agent.settings.canPlace !== false && !!agent.getAction('pillar'),
    blocks,
    headroom: freeAbove(bot),
    protectedHere: agent.protectedAreas.isProtected(me),
    canDig: agent.canDig && !!agent.getAction('bunker'),
    sealable: blocks > 0 || HAND_DROPS.test(floor) || bot.inventory.items().some(i => /_pickaxe$/.test(i.name)),
    roofed: roofAbove(bot, 12) !== null,
    inWater: /water/.test(feet),
    threats: threats.filter(t => t.dist <= 12).map(t => ({ name: t.name, ranged: t.ranged, flying: t.flying })),
    settings: s
  }
}

/**
 * Sprints straight away from the melee mobs around (their centre), steering up to 90 degrees off
 * that line around drops, water and walls (fight.safeStep), jumping when stuck. Seen live: the
 * pathfinder's back-off (GoalInvert) re-planned under every hit and two zombies kept up with it.
 * Stops when the nearest melee mob is `distance` blocks off or after `ms`. Returns that distance.
 */
export async function sprintAway (bot: Bot, signal: AbortSignal, distance: number, ms: number): Promise<number> {
  const until = Date.now() + ms
  let last = bot.entity.position.clone()
  let stuckSince = 0
  const nearest = () => Math.min(Infinity, ...threatsAround(bot, 24).filter(t => !t.ranged && !t.flying).map(t => t.dist))
  try {
    while (Date.now() < until) {
      checkAborted(signal)
      const melee = threatsAround(bot, 16).filter(t => !t.ranged && !t.flying)
      if (!melee.length || nearest() >= distance) break
      const me = bot.entity.position
      const cx = melee.reduce((a, t) => a + t.pos.x, 0) / melee.length - me.x
      const cz = melee.reduce((a, t) => a + t.pos.z, 0) / melee.length - me.z
      const away = Math.atan2(cx, cz) // facing (-cx, -cz): yaw = atan2(-vx, -vz)
      let picked = false
      for (const off of [0, 0.5, -0.5, 1, -1, 1.57, -1.57]) {
        await bot.look(away + off, 0, true).catch(() => {})
        if (safeStep(bot, 'forward') && safeStep(bot, 'forward', 2)) { picked = true; break }
      }
      bot.setControlState('forward', picked)
      bot.setControlState('sprint', picked)
      const moved = Math.hypot(me.x - last.x, me.z - last.z)
      last = me.clone()
      if (moved < 0.1 && picked) { if (!stuckSince) stuckSince = Date.now() } else stuckSince = 0
      bot.setControlState('jump', !!stuckSince && Date.now() - stuckSince > 150)
      await sleep(100, signal)
    }
  } finally { clearMoves(bot) }
  return nearest()
}

/** A melee mob within 3 blocks: sprint off a few blocks before pillaring or digging, or its hits knock the bot off its spot. */
async function breakContact (bot: Bot, signal: AbortSignal): Promise<void> {
  if (!threatsAround(bot, 4).some(t => !t.ranged && !t.flying && t.dist <= 3)) return
  await sprintAway(bot, signal, 7, 2500)
  const settle = Date.now() + 400
  while (!bot.entity.onGround && Date.now() < settle) await sleep(50, signal)
}

const mobInReach = (bot: Bot) => threatsAround(bot, 5).some(t => !t.ranged && t.dist <= 3.5)

/** Shuts open wooden doors within 4 blocks that the bot isn't standing in (mobs then stay out). */
export async function closeDoors (bot: Bot): Promise<number> {
  const me = bot.entity.position.floored()
  let n = 0
  const doors = bot.findBlocks({ matching: (b: any) => /_door$/.test(b.name) && b.name !== 'iron_door', maxDistance: 4, count: 8 })
  for (const p of doors) {
    const b = bot.blockAt(p)
    const props = (b as any)?.getProperties?.() as { open?: boolean, half?: string } | undefined
    if (!b || !props?.open || props.half === 'upper') continue
    if (p.x === me.x && p.z === me.z && Math.abs(p.y - me.y) <= 1) continue
    try { await bot.activateBlock(b); n++ } catch {}
  }
  return n
}

export interface RouteResult { ok: boolean, where: string, /** Where the fight is now anchored (home after going home). */ anchorHere?: boolean, /** The route held the bot until healthy itself (pillar). */ recovered?: boolean }

type Runner = (ctx: ActionContext, s: RetreatSettings) => Promise<RouteResult>

/** One executor per route id (the planner's ESCAPE_ROUTES says when each applies). */
export const ROUTE_RUNNERS: Record<RouteId, Runner> = {
  async home (ctx, s) {
    const r = await runInline(ctx, 'go_home', { range: 2 }).catch(e => ({ ok: false, message: (e as Error).message }))
    if (!r?.ok) return { ok: false, where: r?.message ?? 'no go_home' }
    const shut = s.closeDoors ? await closeDoors(ctx.bot) : 0
    return { ok: true, where: `home at ${fmtPos(ctx.bot.entity.position)}${shut ? `, shut ${shut} door${shut > 1 ? 's' : ''}` : ''}`, anchorHere: true }
  },
  async pillar (ctx, s) {
    const { bot, signal } = ctx
    await breakContact(bot, signal)
    const r = await runInline(ctx, 'pillar', { height: s.pillarHeight }).catch(e => ({ ok: false, message: (e as Error).message }))
    if (!r?.ok) return { ok: false, where: r?.message ?? 'no pillar action' }
    const where = `a ${s.pillarHeight}-block pillar at ${fmtPos(bot.entity.position)}`
    // up there: hit whatever comes into reach (no strafing, no chasing), eat, wait to heal
    const flags = { ...weaponFlags(ctx.agent), strafe: false, maxChase: 0.5 }
    const start = Date.now()
    while (true) {
      checkAborted(signal)
      const near = threatsAround(bot, 6).map(t => bot.entities[t.id]).find((e): e is Entity => !!e && eyeReach(bot, e) <= 3)
      const step = recoverStep({ health: bot.health, food: bot.food, hasFood: !!fightFood(bot), mobInReach: false, elapsedMs: Date.now() - start, settings: s })
      if (step === 'healed' || step === 'give_up') break
      if (near) await fightTarget(bot, near, signal, { maxMs: 1500, flags, tactical: false })
      else if (step === 'eat') await eatNow(bot, signal)
      else await sleep(250, signal)
    }
    return { ok: true, where, recovered: true }
  },
  async bunker (ctx, s) {
    await breakContact(ctx.bot, ctx.signal)
    const r = await runInline(ctx, 'bunker', { depth: 3, maxMinutes: Math.max(0.5, Math.min(15, s.healSeconds / 60)), untilDay: false }).catch(e => ({ ok: false, message: (e as Error).message }))
    return r?.ok ? { ok: true, where: `a bunker: ${r.message}` } : { ok: false, where: r?.message ?? 'no bunker action' }
  },
  async sprint (ctx, s) {
    const d = await sprintAway(ctx.bot, ctx.signal, s.sprintDistance, 12_000)
    const where = `${Math.round(d === Infinity ? s.sprintDistance : d)} blocks from them, at ${fmtPos(ctx.bot.entity.position)}`
    // not clear of them, but well ahead: still an escape (they lose track or it outpaces them)
    return d >= Math.min(12, s.sprintDistance) ? { ok: true, where } : { ok: false, where: `couldn't get away (${where})` }
  }
}

/** Eats and waits after an escape until healthy (returnAbove), cornered, or out of time. */
async function recover (ctx: ActionContext, s: RetreatSettings): Promise<'healed' | 'cornered' | 'gave_up'> {
  const { bot, signal } = ctx
  const start = Date.now()
  while (true) {
    checkAborted(signal)
    if (bot.health <= 0) return 'gave_up'
    const step = recoverStep({ health: bot.health, food: bot.food, hasFood: !!bestFood(bot) || !!fightFood(bot), mobInReach: mobInReach(bot), elapsedMs: Date.now() - start, settings: s })
    if (step === 'fight') return 'cornered'
    if (step === 'healed') return 'healed'
    if (step === 'give_up') return 'gave_up'
    if (step === 'eat') { if (!await eatNow(bot, signal)) await sleep(500, signal) } else await sleep(500, signal)
  }
}

export interface EscapeResult {
  /** A route worked. */
  ok: boolean
  route: RouteId | null
  /** One line for the defend result, the log and the status. */
  note: string
  /** Healthy again and comeBack on: defend may fight on. */
  comeBack: boolean
  /** Re-anchor the fight where it is now (after going home). */
  anchorHere: boolean
}

/**
 * Leaves the fight: tries the usable routes in the configured order, then recovers. `why` is the
 * retreat rule's reason. Logs and notes (status, retreatHistory) why it left and where it went.
 */
export async function escapeFight (ctx: ActionContext, why: string, s: RetreatSettings, order: readonly RouteId[] = s.routes): Promise<EscapeResult> {
  const { bot, agent, log } = ctx
  const plan = planEscape(escapeInputs(ctx, s), order, ESCAPE_ROUTES)
  const skipped = plan.skipped.map(x => `${x.id}: ${x.why}`).join('; ')
  log.info(`retreat: leaving the fight (${why}); routes ${plan.usable.join(', ') || 'none'}${skipped ? ` (skipped ${skipped})` : ''}`)
  const failed: string[] = []
  for (const id of plan.usable) {
    checkAborted(ctx.signal)
    let r: RouteResult
    try { r = await ROUTE_RUNNERS[id](ctx, s) } catch (e) { checkAborted(ctx.signal); r = { ok: false, where: (e as Error).message } }
    if (!r.ok) { failed.push(`${id}: ${r.where}`); log.info(`retreat: ${id} failed (${r.where})`); continue }
    const after = r.recovered ? (bot.health >= s.returnAbove ? 'healed' : 'gave_up') : await recover(ctx, s)
    const note = `left the fight (${why}), escaped to ${r.where}; ${after === 'healed' ? `healed to ${Math.ceil(bot.health)}` : after === 'cornered' ? 'cornered there' : `still at ${Math.ceil(bot.health)} health`}`
    log.info(`retreat: ${note}`)
    agent.status?.noteEvent?.(note)
    noteRetreat(bot, { at: Date.now(), why, route: id, ok: true, detail: note })
    return { ok: true, route: id, note, comeBack: s.comeBack && after !== 'gave_up', anchorHere: !!r.anchorHere }
  }
  const note = `wanted to leave the fight (${why}) but no route worked${failed.length ? ` (${failed.join('; ')})` : ''}${skipped ? `; skipped ${skipped}` : ''}`
  log.info(`retreat: ${note}`)
  agent.status?.noteEvent?.(note)
  noteRetreat(bot, { at: Date.now(), why, route: null, ok: false, detail: note })
  return { ok: false, route: null, note, comeBack: true, anchorHere: false }
}
