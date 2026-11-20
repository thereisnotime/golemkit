// The blackboard: needs and facts the NPC brain refreshes every tick, plus a small memory
// (in-process scratch and persisted keys in agent.storage). Behaviours score from it
// instead of each poking the bot.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../core/index.ts'
import { isHostile } from '../../core/index.ts'
import { getHome, sameDimension, type Place } from '../../skills/navigation.ts'

export interface Needs {
  /** 0 full .. 1 starving (from bot.food). */
  hunger: number
  /** 0 dead .. 1 full health. */
  health: number
  /** 0 safe .. 1 a hostile mob is touching us (by distance within dangerRadius). */
  danger: number
  /** 0 empty .. 1 every inventory slot used. */
  inventoryFull: number
  /** 0 rested .. 1 should sleep: rises through the night. */
  tiredness: number
}

export interface Facts {
  timeOfDay: number
  /** Night in the "beds work" sense (12542..23459) or a thunderstorm. */
  isNight: boolean
  sleeping: boolean
  home: Place | null
  /** Distance to home, or null without a home / in another dimension. */
  homeDistance: number | null
  nearestHostile: { id: number, name: string, distance: number } | null
  nearestPlayer: { name: string, distance: number } | null
}

export interface BlackboardOptions {
  dangerRadius?: number
  /** Mob names never counted as danger (neutral mobs that only fight back). */
  ignoreMobs?: string[]
  /** Radius for nearestPlayer. */
  playerRadius?: number
}

const DEFAULT_IGNORE = ['enderman', 'zombified_piglin', 'piglin']

export class Blackboard {
  needs: Needs = { hunger: 0, health: 1, danger: 0, inventoryFull: 0, tiredness: 0 }
  facts: Facts = {
    timeOfDay: 0,
    isNight: false,
    sleeping: false,
    home: null,
    homeDistance: null,
    nearestHostile: null,
    nearestPlayer: null
  }

  /** Custom needs (0..1 by convention), set by hooks, read by behaviours. */
  readonly custom = new Map<string, number>()
  /** Per-session scratch memory. */
  readonly memory = new Map<string, unknown>()

  private readonly agent: Agent
  private readonly opts: Required<BlackboardOptions>

  constructor (agent: Agent, opts: BlackboardOptions = {}) {
    this.agent = agent
    this.opts = {
      dangerRadius: opts.dangerRadius ?? 12,
      ignoreMobs: opts.ignoreMobs ?? DEFAULT_IGNORE,
      playerRadius: opts.playerRadius ?? 16
    }
  }

  need (name: string): number {
    return this.custom.get(name) ?? (this.needs as unknown as Record<string, number>)[name] ?? 0
  }

  setNeed (name: string, value: number): void {
    this.custom.set(name, value)
  }

  /** Persistent value under npc.<key> in agent.storage. */
  recall<T> (key: string, fallback: T): T {
    return this.agent.storage.get<T>(`npc.${key}`, fallback)
  }

  persist (key: string, value: unknown): void {
    this.agent.storage.set(`npc.${key}`, value)
  }

  /** Refreshes needs and facts from the bot. Tolerates a partially loaded bot. */
  update (bot: Bot): void {
    const pos = bot.entity?.position
    const food = typeof bot.food === 'number' ? bot.food : 20
    const health = typeof bot.health === 'number' ? bot.health : 20
    const timeOfDay = bot.time?.timeOfDay ?? 0
    const storm = (bot as any).thunderState > 0
    const isNight = storm || (timeOfDay >= 12542 && timeOfDay <= 23459)

    const home = getHome(this.agent) ?? null
    const homeDistance = home && pos && sameDimension(bot, home)
      ? Math.hypot(pos.x - home.x, pos.y - home.y, pos.z - home.z)
      : null

    let nearestHostile: Facts['nearestHostile'] = null
    let nearestPlayer: Facts['nearestPlayer'] = null
    if (pos) {
      for (const e of Object.values(bot.entities ?? {})) {
        if (e === bot.entity || !e.position) continue
        const d = e.position.distanceTo(pos)
        if (isHostile(e) && !this.opts.ignoreMobs.includes(e.name ?? '') && d <= this.opts.dangerRadius) {
          if (!nearestHostile || d < nearestHostile.distance) nearestHostile = { id: e.id, name: e.name ?? 'mob', distance: d }
        } else if (e.type === 'player' && e.username && e.username !== bot.username && d <= this.opts.playerRadius) {
          if (!nearestPlayer || d < nearestPlayer.distance) nearestPlayer = { name: e.username, distance: d }
        }
      }
    }

    let used = 0
    let slots = 36
    try {
      const inv = bot.inventory
      if (inv) {
        slots = inv.inventoryEnd - inv.inventoryStart || 36
        used = inv.items().length
      }
    } catch {}

    // Tiredness ramps from dusk (12000) to the latest point beds still work.
    const tiredness = isNight ? 1 : timeOfDay > 11000 && timeOfDay < 12542 ? (timeOfDay - 11000) / 1542 : 0

    this.needs = {
      hunger: Math.max(0, Math.min(1, (20 - food) / 20)),
      health: Math.max(0, Math.min(1, health / 20)),
      danger: nearestHostile ? Math.max(0, 1 - nearestHostile.distance / this.opts.dangerRadius) : 0,
      inventoryFull: Math.min(1, used / slots),
      tiredness
    }
    this.facts = {
      timeOfDay,
      isNight,
      sleeping: !!bot.isSleeping,
      home,
      homeDistance,
      nearestHostile,
      nearestPlayer
    }
  }

  toJSON (): Record<string, unknown> {
    const round = (n: number) => Math.round(n * 100) / 100
    const needs = Object.fromEntries(Object.entries(this.needs).map(([k, v]) => [k, round(v)]))
    for (const [k, v] of this.custom) needs[k] = round(v)
    const f = this.facts
    return {
      needs,
      timeOfDay: f.timeOfDay,
      isNight: f.isNight,
      sleeping: f.sleeping,
      homeDistance: f.homeDistance === null ? null : Math.round(f.homeDistance),
      nearestHostile: f.nearestHostile ? `${f.nearestHostile.name}@${Math.round(f.nearestHostile.distance)}` : null,
      nearestPlayer: f.nearestPlayer ? `${f.nearestPlayer.name}@${Math.round(f.nearestPlayer.distance)}` : null
    }
  }
}
