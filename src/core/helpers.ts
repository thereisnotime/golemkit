// Shared helpers for writing actions.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pf from 'mineflayer-pathfinder'
import { ActionAbortedError } from './action.ts'

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
