// Small helpers shared by the behaviour library. Reading the world is fine here; changing it
// always goes through ctx.act().
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import { isHostile } from '../../../core/index.ts'
import { getHome, getPlaces, sameDimension, type Place } from '../../../skills/navigation.ts'

export interface Point { x: number, y: number, z: number }

export function dist (a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function flatDist (a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** The player to stay with: `player` if given, else the first owner the bot can see, else the first online owner. */
export function ownerTarget (agent: Agent, bot: Bot, player?: string): { name: string, entity: { position: Point } | null } | null {
  const players = bot.players ?? {}
  const online = (n: string) => Object.keys(players).find(p => p.toLowerCase() === n.toLowerCase())
  if (player) {
    const n = online(player)
    return n ? { name: n, entity: players[n]?.entity ?? null } : null
  }
  const owners = agent.owners.map(online).filter((n): n is string => !!n && n !== bot.username)
  const visible = owners.find(n => players[n]?.entity)
  if (visible) return { name: visible, entity: players[visible]!.entity }
  return owners[0] ? { name: owners[0], entity: null } : null
}

/** Centre from options: a named place, explicit x/z (y optional), or home. Null if none. */
export function resolveCenter (agent: Agent, bot: Bot, o: { place?: string, x?: number, y?: number, z?: number }): Place | null {
  if (o.place) {
    const p = getPlaces(agent)[o.place.toLowerCase()] ?? (o.place.toLowerCase() === 'home' ? getHome(agent) : undefined)
    return p && sameDimension(bot, p) ? p : null
  }
  if (o.x !== undefined && o.z !== undefined) return { x: o.x, y: o.y ?? bot.entity?.position.y ?? 64, z: o.z }
  const home = getHome(agent)
  return home && sameDimension(bot, home) ? home : null
}

/** Hostile mobs within `radius` of a point, nearest first. */
export function hostilesNear (bot: Bot, center: Point, radius: number, ignore: string[] = []): { id: number, name: string, distance: number }[] {
  const out: { id: number, name: string, distance: number }[] = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!isHostile(e) || ignore.includes(e.name ?? '')) continue
    const d = dist(e.position, center)
    if (d <= radius) out.push({ id: e.id, name: e.name ?? 'mob', distance: d })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

export function isDay (bot: Bot): boolean {
  const t = bot.time?.timeOfDay ?? 0
  return t < 12542 || t > 23459
}

export function countWhere (bot: Bot, test: (name: string) => boolean): number {
  return (bot.inventory?.items() ?? []).filter(i => test(i.name)).reduce((n, i) => n + i.count, 0)
}
