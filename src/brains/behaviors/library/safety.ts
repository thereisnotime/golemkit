// stay_safe and avoid_mobs. These complement reflexes() rather than repeat them: reflexes
// react to being hit (fight back, retreat at <= 8 health); stay_safe acts earlier and on
// things reflexes don't cover (getting surrounded, fighting in water, being out at night).
// Both use the same retreat/flee actions, and reflex priority (60) always wins over
// behaviour priority (35), so they never pull the body in different directions.
import type { Bot } from 'mineflayer'
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../types.ts'
import type { NpcContext } from '../../npc/index.ts'
import { fillerBlock } from '../../../skills/survival.ts'
import { findStandable, getHome } from '../../../skills/navigation.ts'
import { canPlace } from '../runtime.ts'
import { hostilesNear } from './util.ts'

type Danger = 'surrounded' | 'low_health' | 'water' | 'night' | null

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
  homeRange: z.number().min(2).max(64).default(8).describe('how close to home counts as home at night')
})

type StayO = z.infer<typeof stayOptions>

/** Which danger stay_safe should handle right now, most urgent first. Exported for tests. */
export function assessDanger (ctx: Pick<NpcContext, 'agent' | 'bot' | 'bb'> & { current?: string | null }, o: StayO): Danger {
  const { bot, bb, agent } = ctx
  // once backing off, keep at it until the mob is well behind us (no stop/start at the edge)
  const running = ctx.current === 'stay_safe'
  const pos = bot.entity?.position
  if (!pos) return null
  const health = typeof bot.health === 'number' ? bot.health : 20
  const close = hostilesNear(bot, pos, 6)
  if (close.length >= o.surroundedBy) return 'surrounded'
  const near = hostilesNear(bot, pos, running ? Math.max(20, o.mobRadius) : o.mobRadius)
  if (near.length && o.retreatBelow > 0 && health <= (running ? o.retreatBelow + 2 : o.retreatBelow)) return 'low_health'
  if (o.avoidWater && near.length && health < 16 && inWater(bot)) return 'water'
  if (o.homeAtNight && bb.facts.isNight && !bb.facts.sleeping && getHome(agent) && bb.facts.homeDistance !== null && bb.facts.homeDistance > o.homeRange) return 'night'
  return null
}

export const staySafe = defineBehavior({
  name: 'stay_safe',
  category: 'safety',
  description: 'Keeps the bot alive: backs away from mobs at low health, pillars up when surrounded (if it can place blocks), ' +
    'gets out of water when mobs are around, and heads home at night if a home is set. Arm it on any bot that roams.',
  options: stayOptions,
  uses: ['retreat', 'flee', 'pillar', 'goto', 'go_home'],
  priority: 'behavior',
  create (o, { agent }) {
    return {
      failureCooldownMs: 4000,
      maxFailureCooldownMs: 30_000,
      score (ctx) {
        switch (assessDanger(ctx, o)) {
          case 'surrounded': return 92
          case 'low_health': return 88
          case 'water': return 78
          case 'night': return ctx.current === 'stay_safe' ? 50 : 48
          default: return 0
        }
      },
      async run (ctx) {
        const danger = assessDanger(ctx, o)
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
          case 'night':
            return agent.getAction('go_home') ? ctx.act('go_home', { range: Math.min(o.homeRange, 4) }) : 'no go_home action'
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
      score: ({ bot }) => nearest(bot) ? 80 : 0,
      async run (ctx) {
        const mob = nearest(ctx.bot)
        if (!mob) return 'nothing close'
        return ctx.act('flee', { distance: Math.min(32, Math.max(8, o.distance * 2)), entityId: mob.id })
      }
    }
  }
})
