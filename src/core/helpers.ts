// Shared helpers for writing actions.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pf from 'mineflayer-pathfinder'
import { ActionAbortedError, checkAborted } from './action.ts'

export const { goals, Movements } = pf
export type Goal = InstanceType<typeof pf.goals.GoalBlock> | any

/** pathfinder.goto that stops when the signal aborts. */
export async function goto (bot: Bot, goal: Goal, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ActionAbortedError()
  const onAbort = () => bot.pathfinder.stop()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await bot.pathfinder.goto(goal)
  } catch (e) {
    if (signal.aborted) throw new ActionAbortedError()
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  if (signal.aborted) throw new ActionAbortedError()
}

/** goto with a time limit; throws "took too long" when it runs out. */
export async function gotoTimed (bot: Bot, goal: Goal, signal: AbortSignal, ms: number): Promise<void> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    await goto(bot, goal, ctl.signal)
  } catch (e) {
    checkAborted(signal)
    if (ctl.signal.aborted) throw new Error('took too long to get there')
    throw e
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export interface TravelOptions {
  /** Length of each leg in blocks (the pathfinder only plans through loaded chunks). Default 64. */
  stepBlocks?: number
  /** Give up on a leg after this long. Default 60 s. */
  stepTimeoutMs?: number
  /** Arrival tolerance (horizontal). Default 2. */
  range?: number
  onProgress? (info: { remaining: number, at: string }): void
}

/**
 * Walks to a far target in legs: each leg aims ~64 blocks closer, so the pathfinder only ever
 * plans through chunks that are loaded around the bot. Blocked legs try detours (angled
 * waypoints); after a few legs without progress it throws "stuck at ...". It only returns
 * when the bot actually stands at the target.
 */
export async function travel (bot: Bot, target: { x: number, y?: number, z: number }, signal: AbortSignal, opts: TravelOptions = {}): Promise<void> {
  const step = opts.stepBlocks ?? 64
  const legMs = opts.stepTimeoutMs ?? 60_000
  const range = opts.range ?? 2
  const flat = () => Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  const ANGLES = [0, 30, -30, 60, -60, 90, -90]
  let stuckLegs = 0

  while (true) {
    checkAborted(signal)
    const remaining = flat()
    if (remaining <= step) {
      const goal = target.y === undefined
        ? new goals.GoalNearXZ(target.x, target.z, range)
        : new goals.GoalNear(target.x, target.y, target.z, range)
      try { await gotoTimed(bot, goal, signal, legMs) } catch (e) { checkAborted(signal) }
      const d = flat()
      const dy = target.y === undefined ? 0 : Math.abs(target.y - bot.entity.position.y)
      if (d <= range + 1 && dy <= 3) return
      if (++stuckLegs >= 3) throw new Error(`couldn't reach the exact spot, stopped ${Math.round(d)} blocks away at ${fmtPos(bot.entity.position)}`)
      continue
    }
    const pos = bot.entity.position
    const base = Math.atan2(target.z - pos.z, target.x - pos.x)
    let progressed = false
    for (const deg of ANGLES) {
      checkAborted(signal)
      const a = base + deg * Math.PI / 180
      const wx = pos.x + Math.cos(a) * step
      const wz = pos.z + Math.sin(a) * step
      try {
        await gotoTimed(bot, new goals.GoalNearXZ(wx, wz, 6), signal, legMs)
      } catch {
        checkAborted(signal)
      }
      if (flat() < remaining - 8) { progressed = true; break }
    }
    if (!progressed) {
      if (++stuckLegs >= 3) throw new Error(`stuck at ${fmtPos(bot.entity.position)}, ${Math.round(flat())} blocks left`)
    } else {
      stuckLegs = 0
      opts.onProgress?.({ remaining: Math.round(flat()), at: fmtPos(bot.entity.position) })
    }
  }
}

/** Sets a dynamic goal until the signal aborts (follow-style). Resolves on abort. */
export function holdGoal (bot: Bot, goal: Goal, signal: AbortSignal): Promise<void> {
  bot.pathfinder.setGoal(goal, true)
  return new Promise(resolve => {
    const done = () => { bot.pathfinder.setGoal(null); resolve() }
    if (signal.aborted) return done()
    signal.addEventListener('abort', done, { once: true })
  })
}

export function playerEntity (bot: Bot, name: string | undefined): Entity | undefined {
  if (!name) return undefined
  return bot.players[name]?.entity
}

export function isHostile (e: Entity | null | undefined): e is Entity {
  return !!e && e.type === 'hostile' && (e as any).isValid !== false
}

export function nearestHostile (bot: Bot, from: { distanceTo (p: any): number }, radius: number): Entity | null {
  return bot.nearestEntity(e => isHostile(e) && from.distanceTo(e.position) <= radius)
}

export function itemName (item: { name?: string, type: number }): string {
  return item.name && item.name !== 'unknown' ? item.name : `modded#${item.type}`
}

export function fmtPos (p: { x: number, y: number, z: number }): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
}
