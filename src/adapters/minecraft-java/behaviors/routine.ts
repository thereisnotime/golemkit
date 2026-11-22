// Routine behaviours wrapping the NPC brain's existing ones (sleep_at_night, return_home,
// wander), plus guard_area.
import { z, fmtPos } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { sleepAtNight as npcSleep, goHome as npcHome, wander as npcWander } from '../../../brains/npc/index.ts'
import { resolveCenter, hostilesNear, flatDist } from './util.ts'

const strip = <T extends { name: string, priority?: number }>(b: T) => {
  const { name: _n, priority: _p, ...rest } = b
  return rest
}

export const sleepAtNightBehavior = defineBehavior({
  name: 'sleep_at_night',
  category: 'routine',
  description: 'At night walks home (if a home is set) and sleeps in a bed there until morning. Needs a bed within 16 blocks of home.',
  options: z.object({
    homeRange: z.number().min(1).max(64).default(8).describe('walk home first when farther than this')
  }),
  requires: ['sleep'],
  uses: ['go_home'],
  priority: 'npc',
  create: (o) => strip(npcSleep({ homeRange: o.homeRange }))
})

export const returnHome = defineBehavior({
  name: 'return_home',
  category: 'routine',
  description: 'Walks back home when it strays too far by day, and stays close to home at night. Needs a home (set_home).',
  options: z.object({
    maxDistance: z.number().min(4).max(512).default(32).describe('head home when farther than this by day'),
    nightDistance: z.number().min(2).max(128).default(6).describe('at night, head home when farther than this')
  }),
  requires: ['go_home'],
  priority: 'npc',
  create: (o) => strip(npcHome({ maxDistance: o.maxDistance, nightDistance: o.nightDistance }))
})

export const wanderBehavior = defineBehavior({
  name: 'wander',
  category: 'idle',
  description: 'Takes short walks near home (or where it is) with pauses in between, when nothing else is going on.',
  options: z.object({
    radius: z.number().min(1).max(64).default(12).describe('how far to wander by day'),
    nightRadius: z.number().min(1).max(64).default(4).describe('how far to wander at night')
  }),
  requires: ['wander'],
  priority: 'idle',
  create: (o) => strip(npcWander({ radius: o.radius, nightRadius: o.nightRadius }))
})

const areaOptions = z.object({
  place: z.string().optional().describe('remembered place to guard (remember_place); default x/z, else home, else where it was armed'),
  x: z.number().optional().describe('centre x'),
  y: z.number().optional().describe('centre y'),
  z: z.number().optional().describe('centre z'),
  radius: z.number().min(4).max(48).default(12).describe('guard this far around the centre'),
  patrol: z.boolean().default(true).describe('walk around the area when it is quiet')
})

export const guardArea = defineBehavior({
  name: 'guard_area',
  category: 'combat',
  description: 'Defends an area (a remembered place, coordinates, or where it stands when armed): kills hostile mobs that enter ' +
    'it and patrols when quiet. Never attacks players or animals. Arm it to protect a base or farm.',
  options: areaOptions,
  requires: ['attack'],
  uses: ['goto', 'wander'],
  priority: 'npc',
  prepare (o, { agent }) {
    if (o.place || (o.x !== undefined && o.z !== undefined) || !agent.connected) return o
    const p = agent.bot.entity.position
    return { ...o, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  },
  create (o, { agent }) {
    const mode = (bot: Parameters<typeof resolveCenter>[1]) => {
      const c = resolveCenter(agent, bot, o)
      if (!c || !bot.entity) return null
      const mob = hostilesNear(bot, c, o.radius)[0]
      if (mob) return { kind: 'fight' as const, c, mob }
      if (flatDist(bot.entity.position, c) > o.radius) return { kind: 'return' as const, c }
      return o.patrol ? { kind: 'patrol' as const, c } : null
    }
    return {
      failureCooldownMs: 5000,
      maxFailureCooldownMs: 60_000,
      score ({ bot }) {
        const m = mode(bot)
        return !m ? 0 : m.kind === 'fight' ? 60 : m.kind === 'return' ? 28 : 12
      },
      async run (ctx) {
        const m = mode(ctx.bot)
        if (!m) return 'nothing to guard'
        if (m.kind === 'fight') return ctx.act('attack', { entityId: m.mob.id })
        if (m.kind === 'return') {
          if (!agent.getAction('goto')) return { ok: false, message: 'no goto action to get back to the area' }
          return ctx.act('goto', { x: Math.floor(m.c.x), y: Math.floor(m.c.y), z: Math.floor(m.c.z) })
        }
        if (agent.getAction('wander')) {
          const r = await ctx.act('wander', { radius: Math.min(64, o.radius), x: m.c.x, z: m.c.z })
          await ctx.wait(3000 + Math.random() * 5000)
          return r.ok ? r : `patrolling around ${fmtPos(m.c)}`
        }
        await ctx.wait(5000)
        return `watching ${fmtPos(m.c)}`
      }
    }
  }
})
