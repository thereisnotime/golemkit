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
  let force: NodeJS.Timeout | undefined
  let onAbort = () => {}
  // pathfinder.stop() only settles goto() at the next path node. When the pathfinder is wedged
  // (a goal set but no movement, seen live) that never happens, so clear the goal after a grace.
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      bot.pathfinder.stop()
      force = setTimeout(() => {
        try { bot.pathfinder.setGoal(null) } catch {}
        reject(new ActionAbortedError())
      }, 2000)
    }
  })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([bot.pathfinder.goto(goal), aborted])
  } catch (e) {
    if (signal.aborted) throw new ActionAbortedError()
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (force) clearTimeout(force)
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

/** Height of the open-sky ground (first solid block or water from the top) at x/z, if loaded. */
export function surfaceY (bot: Bot, x: number, z: number): number | null {
  const from = Math.min(319, Math.floor(bot.entity.position.y) + 64)
  for (let y = from; y > -64; y--) {
    const b = bot.blockAt(bot.entity.position.floored().set(Math.floor(x), y, Math.floor(z)))
    if (!b) return null
    if (b.name === 'water' || b.name === 'lava' || (b.boundingBox === 'block' && !b.name.endsWith('_leaves'))) return y + 1
  }
  return null
}

/** A solid roof within `range` blocks above the head (leaves and glass don't count). */
export function roofed (bot: Bot, range = 24): boolean {
  const p = bot.entity.position.floored()
  for (let dy = 2; dy <= range; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (b && b.boundingBox === 'block' && !/leaves|glass/.test(b.name)) return true
  }
  return false
}

/**
 * One travel leg: aims at the ground surface (not just x/z, which lets a digging pathfinder tunnel
 * straight through the terrain), and stops if the route goes deep underground under a roof.
 */
async function surfaceLeg (bot: Bot, x: number, z: number, range: number, signal: AbortSignal, ms: number, startY: number): Promise<void> {
  const sy = surfaceY(bot, x, z)
  const goal = sy !== null ? new goals.GoalNear(x, sy, z, range) : new goals.GoalNearXZ(x, z, range)
  const ctl = new AbortController()
  const leg = AbortSignal.any([signal, ctl.signal])
  let under = false
  const watch = setInterval(() => {
    const y = bot.entity?.position.y ?? startY
    if (y < Math.min(startY, sy ?? startY) - 12 && roofed(bot, 32)) { under = true; ctl.abort() }
  }, 1000)
  try {
    await gotoTimed(bot, goal, leg, ms)
  } catch (e) {
    checkAborted(signal)
    if (!under) throw e
  } finally {
    clearInterval(watch)
  }
  if (under) throw new TravelUndergroundError(`the route went underground at ${fmtPos(bot.entity.position)}; stopped there`)
}

/** A travel leg went deep underground (caves, ravines): the caller should climb out or give up. */
export class TravelUndergroundError extends Error {}

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
      if (target.y === undefined) {
        try { await surfaceLeg(bot, target.x, target.z, range, signal, legMs, bot.entity.position.y) } catch (e) { checkAborted(signal); if (e instanceof TravelUndergroundError) throw e }
      } else {
        try { await gotoTimed(bot, new goals.GoalNear(target.x, target.y, target.z, range), signal, legMs) } catch (e) { checkAborted(signal) }
      }
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
        await surfaceLeg(bot, wx, wz, 6, signal, legMs, pos.y)
      } catch (e) {
        checkAborted(signal)
        if (e instanceof TravelUndergroundError) throw e
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

/** Neutral mobs: dangerous only when provoked, so never targeted proactively. */
const NEUTRAL = new Set(['enderman', 'piglin', 'zombified_piglin', 'evoker_fangs', 'skeleton_horse', 'zombie_horse'])
/** minecraft-data types these as plain "mob" although they attack on sight. */
const ALSO_HOSTILE = new Set(['phantom', 'ghast', 'slime', 'magma_cube', 'shulker', 'hoglin', 'ender_dragon'])
/** Mobs that fly: chasing them on foot is pointless, swing when they come into reach. */
export const FLYING = new Set(['phantom', 'ghast', 'vex', 'blaze', 'breeze', 'bee', 'allay', 'parrot', 'bat', 'ender_dragon'])

export function isHostile (e: Entity | null | undefined): e is Entity {
  if (!e || (e as any).isValid === false) return false
  const name = e.name ?? ''
  if (NEUTRAL.has(name)) return false
  return e.type === 'hostile' || ALSO_HOSTILE.has(name)
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

/** True in survival/adventure, where hunger, damage and gathering matter. */
export function needsSurvival (bot: Bot): boolean {
  const m = bot.game?.gameMode
  return m !== 'creative' && m !== 'spectator'
}

/** One line telling a model what the current game mode means for it. */
export function gameModeNote (mode: string | undefined): string {
  switch (mode) {
    case 'creative': return 'creative: any item via creative_get, can fly, no hunger or damage, blocks break instantly; build freely, do not gather'
    case 'spectator': return 'spectator: can only fly and watch, cannot interact or build'
    case 'adventure': return 'adventure: cannot break or place blocks without the right tools/tags; hunger and damage apply'
    default: return 'survival: hunger and damage apply; gather and craft what you need'
  }
}
