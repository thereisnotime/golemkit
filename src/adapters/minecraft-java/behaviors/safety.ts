// stay_safe and avoid_mobs. These complement reflexes() rather than repeat them: reflexes
// react to being hit (fight back, retreat at <= 8 health); stay_safe acts earlier and on
// things reflexes don't cover (getting surrounded, fighting in water, being out at night).
// Both use the same retreat/flee actions, and reflex priority (60) always wins over
// behaviour priority (35), so they never pull the body in different directions.
import { needsSurvival } from '../../../core/index.ts'
import type { Bot } from 'mineflayer'
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import type { NpcContext, BehaviorContext } from '../../../brains/npc/index.ts'
import type { ActionResult } from '../../../core/index.ts'
import { fillerBlock, bestFood, roofAbove } from '../../../skills/survival.ts'
import { wornArmorPoints } from '../../../skills/gear.ts'
import { unpreparedForNight } from '../../../skills/tactics.ts'
import { findStandable, getHome, homeOffset, sameDimension } from '../../../skills/navigation.ts'
import { failureCooldown } from '../../../brains/npc/index.ts'
import { canPlace } from '../../../brains/behaviors/runtime.ts'
import { hostilesNear } from './util.ts'
import { escorting } from '../../../skills/bodyguard.ts'
import { rangedSituation } from '../../../skills/ranged.ts'
import { gearScore, gearNeeded, RANGED_OUTNUMBERED } from '../../../skills/ranged-plan.ts'
import { hasRanged, bestMeleeDamage } from '../../../skills/weapons.ts'

/** Health at or below which an escorting bodyguard treats a crowd around it as surrounded. */
const ESCORT_SURROUNDED_HEALTH = 12

type Danger = 'surrounded' | 'ranged' | 'low_health' | 'water' | 'night' | 'hold' | 'shelter' | null

/** Health at or below which stay_safe takes cover from shooters with a line to the bot. */
export const RANGED_COVER_HEALTH = 12

/**
 * Whether shooters around call for cover now (pure): one with a line to the bot (or that just
 * shot it) and the bot hurt, or a patrol / several shooters and a gear score (gearScore: armour,
 * shield, weapon, bow and arrows, health) under what that many need (gearNeeded). An escorting
 * bodyguard only at 8 health or less (protect fights archers for its player). Without
 * `weaponDamage` an iron sword is assumed; without `bow` none. Exported for tests (and for
 * keep_fed, which reads it).
 */
export function rangedDanger (s: { active: number, patrol: number, health: number, armor: number, shield: boolean, escorting: boolean, weaponDamage?: number, bow?: boolean, arrows?: number }): boolean {
  if (!s.active) return false
  if (s.escorting) return s.health <= 8
  if (s.health <= RANGED_COVER_HEALTH) return true
  const many = Math.max(s.active, s.patrol)
  if (many < RANGED_OUTNUMBERED) return false
  const score = gearScore({ armor: s.armor, shield: s.shield, weaponDamage: s.weaponDamage ?? 6, bow: !!s.bow, arrows: s.bow ? (s.arrows ?? 16) : 0, health: s.health })
  return score < gearNeeded(many)
}

/** After a failed go_home, how long before stay_safe tries it again (doubles per failure, capped). */
export const HOME_BACKOFF_MS = 60_000
export const MAX_HOME_BACKOFF_MS = 5 * 60_000
/** After getting home, wandering this much past homeRange is allowed before it heads back again... */
export const HOME_SETTLE_SLACK = 4
/** ...for this long, so a chore at the edge of homeRange doesn't send it home every few seconds. */
export const HOME_SETTLE_MS = 3 * 60_000

/** go_home back-off for the n-th failure in a row. Pure, exported for tests. */
export function homeBackoffMs (failures: number): number {
  return failureCooldown(failures, HOME_BACKOFF_MS, MAX_HOME_BACKOFF_MS)
}

/** What stay_safe remembers about its trips home (one per armed instance). */
export interface HomeTrips {
  /** No go_home attempts before this (ms); the bot holds position instead. */
  backoffUntil: number
  /** go_home failures in a row. */
  failures: number
  /** When it last got (or already was) home, ms. */
  arrivedAt: number
}

export function newHomeTrips (): HomeTrips {
  return { backoffUntil: 0, failures: 0, arrivedAt: -Infinity }
}

/**
 * Whether the bot should (still) head home at night, with hysteresis: it starts when farther
 * than homeRange (plus HOME_SETTLE_SLACK shortly after arriving), and once on its way keeps
 * going until within arriveRange. Pure, exported for tests.
 */
export function needsHome (offset: number, o: { homeRange: number, arriveRange: number, running: boolean, sinceArrivedMs: number }): boolean {
  // just arrived (go_home said so): trust it even mid-run, or a spot right at the edge of
  // arriveRange sends it home again every second
  if (o.sinceArrivedMs < HOME_SETTLE_MS) return offset > o.homeRange + HOME_SETTLE_SLACK
  if (o.running) return offset > o.arriveRange
  return offset > o.homeRange
}

/** The range stay_safe passes to go_home. */
function arriveRange (o: { homeRange: number }): number {
  return Math.min(o.homeRange, 4)
}

function inWater (bot: Bot): boolean {
  const p = bot.entity?.position
  if (!p) return false
  return bot.blockAt(p)?.name === 'water' || bot.blockAt(p.offset(0, 1, 0))?.name === 'water'
}

const stayOptions = z.object({
  retreatBelow: z.number().min(0).max(20).default(10).describe('back off from nearby mobs at or below this health; 0 = never (reflexes retreat at 8 when hit)'),
  mobRadius: z.number().min(4).max(24).default(10).describe('mobs this close count as a threat'),
  surroundedBy: z.number().int().min(2).max(10).default(3).describe('this many hostiles within 6 blocks means surrounded'),
  pillar: z.boolean().default(true).describe('when surrounded, pillar up out of reach (needs blocks and block placing)'),
  avoidWater: z.boolean().default(true).describe('get out of water when hostiles are near and health is below 16'),
  homeAtNight: z.boolean().default(true).describe('go home at night if a home is set'),
  homeRange: z.number().min(2).max(64).default(8).describe('how close to home counts as home at night'),
  shelterUnprepared: z.boolean().default(true).describe('at night without armour, a weapon or food and no home: dig in (bunker) until morning'),
  ranged: z.boolean().default(true).describe('take cover (or back out of range) from skeletons, pillagers and other shooters when hurt or outnumbered, and eat behind cover')
})

/** Why the bot shouldn't be out tonight (no armour, weapon or food), or null. Exported for tests. */
export function nightUnready (bot: Bot): string | null {
  const items = bot.inventory?.items?.() ?? []
  return unpreparedForNight({
    armorPoints: bot.inventory?.slots ? wornArmorPoints(bot) : 0,
    hasWeapon: items.some(i => /_(sword|axe)$/.test(i.name)),
    hasFood: !!bestFood(bot)
  })
}

type StayO = z.infer<typeof stayOptions>

/** Which danger stay_safe should handle right now, most urgent first. Exported for tests. */
export function assessDanger (ctx: Pick<NpcContext, 'agent' | 'bot' | 'bb'> & { current?: string | null, now?: number }, o: StayO, trips: HomeTrips = newHomeTrips()): Danger {
  const { bot, bb, agent } = ctx
  // once backing off, keep at it until the mob is well behind us (no stop/start at the edge)
  const running = ctx.current === 'stay_safe'
  const pos = bot.entity?.position
  if (!pos) return null
  const health = typeof bot.health === 'number' ? bot.health : 20
  const close = hostilesNear(bot, pos, 6)
  // a bodyguard is surrounded whenever a wave reaches its player: it fights next to them while
  // it is healthy and only pillars or backs off once it is getting hurt
  if (close.length >= o.surroundedBy && (health <= ESCORT_SURROUNDED_HEALTH || !escorting(agent))) return 'surrounded'
  // shooters with a line to us: hide and eat behind cover instead of backing off through the open
  if (o.ranged && agent.getAction?.('ranged_defense')) {
    try {
      const r = rangedSituation(bot)
      const items = bot.inventory?.items?.() ?? []
      const shield = bot.inventory?.slots?.[45]?.name === 'shield' || items.some(i => i.name === 'shield')
      const arrows = items.filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      if (rangedDanger({
        active: r.active.length,
        patrol: r.patrol,
        health,
        armor: bot.inventory?.slots ? wornArmorPoints(bot) : 0,
        shield,
        escorting: !!escorting(agent),
        weaponDamage: bestMeleeDamage(items.map(i => i.name)),
        bow: !!hasRanged(bot),
        arrows
      })) return 'ranged'
    } catch {}
  }
  const near = hostilesNear(bot, pos, running ? Math.max(20, o.mobRadius) : o.mobRadius)
  if (near.length && o.retreatBelow > 0 && health <= (running ? o.retreatBelow + 2 : o.retreatBelow)) return 'low_health'
  if (o.avoidWater && near.length && health < 16 && inWater(bot)) return 'water'
  // an armed bodyguard with its player online stays with them at night (the dangers above still apply)
  if (escorting(agent)) return null
  const home = getHome(agent)
  // down its own mine (dig_mine) night doesn't matter: the trip has its own retreat rules and comes back up on its own
  const mining = agent.currentAction?.name === 'dig_mine'
  if (o.homeAtNight && bb.facts.isNight && !bb.facts.sleeping && home && sameDimension(bot, home) && !mining) {
    const now = ctx.now ?? Date.now()
    if (needsHome(homeOffset(pos, home), { homeRange: o.homeRange, arriveRange: arriveRange(o), running, sinceArrivedMs: now - trips.arrivedAt })) {
      // go_home just failed: don't try again every few seconds, stand guard where it is meanwhile
      return now < trips.backoffUntil ? 'hold' : 'night'
    }
    return null
  }
  // no home to go to and not fit for a night outside: dig in, unless already under a roof
  if (o.shelterUnprepared && bb.facts.isNight && !bb.facts.sleeping && !getHome(agent) && agent.canDig && agent.getAction?.('bunker') &&
      !agent.protectedAreas?.isProtected(pos) && nightUnready(bot) && roofAbove(bot, 12) === null) return 'shelter'
  return null
}

export const staySafe = defineBehavior({
  name: 'stay_safe',
  capabilities: ['move', 'combat'],
  category: 'safety',
  description: 'Keeps the bot alive: backs away from mobs at low health, pillars up when surrounded (if it can place blocks), ' +
    'takes cover from skeletons, pillagers and other shooters when hurt or outnumbered (and eats behind cover), ' +
    'gets out of water when mobs are around, heads home at night if a home is set (sooner when it has no armour, weapon or food), ' +
    'and without a home digs in for the night when it is unprepared. Arm it on any bot that roams.',
  options: stayOptions,
  uses: ['retreat', 'flee', 'pillar', 'goto', 'go_home', 'bunker', 'ranged_defense'],
  priority: 'behavior',
  create (o, { agent }) {
    const trips = newHomeTrips()
    // Shelter in place after a failed go_home: dig in when unprepared and allowed to, else stand
    // guard until the back-off ends or a more urgent danger shows up (which this run then yields to).
    const holdPosition = async (ctx: BehaviorContext): Promise<ActionResult | string> => {
      const pos = ctx.bot.entity.position
      if (agent.canDig && agent.getAction('bunker') && !agent.protectedAreas?.isProtected(pos) &&
          nightUnready(ctx.bot) && roofAbove(ctx.bot, 12) === null) {
        return ctx.act('bunker', { untilDay: true })
      }
      while (Date.now() < trips.backoffUntil) {
        await ctx.wait(1000)
        const d = assessDanger({ ...ctx, current: 'stay_safe', now: Date.now() }, o, trips)
        if (d !== 'hold') break
      }
      return `stood guard at ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`
    }
    return {
      failureCooldownMs: 4000,
      maxFailureCooldownMs: 30_000,
      score (ctx) {
        if (!needsSurvival(ctx.bot)) return 0 // creative/spectator: mobs can't hurt us
        switch (assessDanger(ctx, o, trips)) {
          case 'surrounded': return 92
          case 'ranged': return 91 // above keep_fed's 90: starving is no reason to walk through crossbow fire
          case 'low_health': return 88
          case 'water': return 78
          case 'night': return nightUnready(ctx.bot) ? 70 : ctx.current === 'stay_safe' ? 50 : 48 // unprepared: home beats other jobs
          case 'hold': return nightUnready(ctx.bot) ? 40 : 0 // stay put rather than wander off after a failed trip
          case 'shelter': return 66
          default: return 0
        }
      },
      async run (ctx) {
        const danger = assessDanger(ctx, o, trips)
        const back = agent.getAction('retreat') ? 'retreat' : agent.getAction('flee') ? 'flee' : null
        switch (danger) {
          case 'surrounded':
            if (o.pillar && canPlace(agent) && agent.getAction('pillar') && fillerBlock(ctx.bot)) {
              const r = await ctx.act('pillar', { height: 3 })
              if (r.ok) {
                // stay up there until the crowd thins out or it gets light
                const until = Date.now() + 90_000
                while (hostilesNear(ctx.bot, ctx.bot.entity.position, 8).length >= 2 && Date.now() < until) await ctx.wait(2000)
                return r
              }
            }
            return back ? ctx.act(back, { distance: 20 }) : 'surrounded and nothing to do about it'
          case 'ranged':
            return ctx.act('ranged_defense', { cover: true })
          case 'low_health':
            return back ? ctx.act(back, { distance: 20 }) : 'no way to back off'
          case 'water': {
            const p = ctx.bot.entity.position
            for (let r = 2; r <= 10; r += 2) {
              for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
                const spot = findStandable(ctx.bot, Math.floor(p.x) + dx, Math.floor(p.y), Math.floor(p.z) + dz, 4)
                if (spot && ctx.bot.blockAt(p.floored().offset(dx, spot.y - Math.floor(p.y), dz))?.name !== 'water' && agent.getAction('goto')) {
                  return ctx.act('goto', { x: spot.x, y: spot.y, z: spot.z })
                }
              }
            }
            return agent.getAction('flee') ? ctx.act('flee', { distance: 16 }) : 'no dry land nearby'
          }
          case 'shelter':
            return ctx.act('bunker', { untilDay: true })
          case 'night': {
            if (!agent.getAction('go_home')) return 'no go_home action'
            const r = await ctx.act('go_home', { range: arriveRange(o) })
            if (r.ok) {
              trips.failures = 0
              trips.arrivedAt = Date.now()
              return r
            }
            trips.failures++
            const wait = homeBackoffMs(trips.failures)
            trips.backoffUntil = Date.now() + wait
            ctx.log.debug(`stay_safe: go_home failed (${r.message}), not trying again for ${Math.round(wait / 1000)}s, holding position`)
            return holdPosition(ctx)
          }
          case 'hold':
            return holdPosition(ctx)
          default:
            return 'safe'
        }
      }
    }
  }
})

const avoidOptions = z.object({
  mobs: z.array(z.string()).default(['creeper', 'warden']).describe('mob names to keep away from'),
  distance: z.number().min(3).max(16).default(7).describe('start moving away when one is this close')
})

export const avoidMobs = defineBehavior({
  name: 'avoid_mobs',
  capabilities: ['move'],
  category: 'safety',
  description: 'Keeps its distance from dangerous mobs (creepers, wardens by default) instead of fighting them. Arm it on bots that work outdoors.',
  options: avoidOptions,
  requires: ['flee'],
  priority: 'behavior',
  create (o) {
    const nearest = (bot: Bot) => {
      const pos = bot.entity?.position
      if (!pos) return null
      let best: { id: number, d: number } | null = null
      for (const e of Object.values(bot.entities ?? {})) {
        if (e === bot.entity || e.type === 'player' || !o.mobs.includes(e.name ?? '') || !e.position) continue
        const d = e.position.distanceTo(pos)
        if (d <= o.distance && (!best || d < best.d)) best = { id: e.id, d }
      }
      return best
    }
    return {
      failureCooldownMs: 2000,
      maxFailureCooldownMs: 10_000,
      score: ({ bot }) => needsSurvival(bot) && nearest(bot) ? 80 : 0,
      async run (ctx) {
        const mob = nearest(ctx.bot)
        if (!mob) return 'nothing close'
        return ctx.act('flee', { distance: Math.min(32, Math.max(8, o.distance * 2)), entityId: mob.id })
      }
    }
  }
})
