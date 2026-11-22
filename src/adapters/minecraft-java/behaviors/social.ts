// Social behaviours: follow_owner, guard_owner, greet_players, idle_look.
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { greetPlayers } from '../../../brains/npc/index.ts'
import { ownerTarget, dist } from './util.ts'

export const followOwner = defineBehavior({
  name: 'follow_owner',
  category: 'social',
  description: 'Follows its owner (or a given player) at a distance whenever they are online and in sight, and walks to catch up ' +
    '(no teleporting) when they are far. Arm it when your owner wants you to come along.',
  options: z.object({
    player: z.string().optional().describe('who to follow; default the first owner online'),
    distance: z.number().min(1).max(16).default(3).describe('how close to stay, in blocks'),
    catchUp: z.number().min(8).max(128).default(32).describe('beyond this, walk over with goto before following')
  }),
  requires: ['follow'],
  uses: ['goto'],
  priority: 'npc',
  prepare (o, { agent, player }) {
    // "follow me" from a non-owner can't get here (owners only), but an owner may mean themselves
    return o.player || !player || agent.isOwner(player) ? o : { ...o, player }
  },
  create (o, { agent }) {
    return {
      failureCooldownMs: 10_000,
      maxFailureCooldownMs: 60_000,
      score ({ bot }) {
        const t = ownerTarget(agent, bot, o.player)
        return t?.entity ? 26 : 0
      },
      async run (ctx) {
        const t = ownerTarget(agent, ctx.bot, o.player)
        if (!t?.entity) return { ok: false, message: 'owner not in sight' }
        const d = dist(t.entity.position, ctx.bot.entity.position)
        if (d > o.catchUp && agent.getAction('goto')) {
          const p = t.entity.position
          const r = await ctx.act('goto', { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
          if (!r.ok) return r
        }
        // follow is long-running: this holds until the brain switches away or something outranks it
        return ctx.act('follow', { player: t.name, distance: o.distance })
      }
    }
  }
})

export const guardOwner = defineBehavior({
  name: 'guard_owner',
  category: 'combat',
  description: 'Stays near its owner (or a given player) and kills hostile mobs that come close to them, like the guard action ' +
    'but persistent: it picks up again after interruptions and restarts. Arm it as a bodyguard.',
  options: z.object({
    player: z.string().optional().describe('who to protect; default the first owner online'),
    radius: z.number().min(4).max(32).default(12).describe('fight mobs this close to them')
  }),
  requires: ['guard'],
  priority: 'npc',
  create (o, { agent }) {
    return {
      failureCooldownMs: 10_000,
      maxFailureCooldownMs: 60_000,
      score: ({ bot }) => ownerTarget(agent, bot, o.player)?.entity ? 32 : 0,
      async run (ctx) {
        const t = ownerTarget(agent, ctx.bot, o.player)
        if (!t?.entity) return { ok: false, message: 'nobody to guard in sight' }
        return ctx.act('guard', { player: t.name, radius: o.radius })
      }
    }
  }
})

export const greetPlayersBehavior = defineBehavior({
  name: 'greet_players',
  category: 'social',
  description: 'Says hello in chat, now and then, to players who come close (rate limited per player and overall). Flavour for NPCs.',
  options: z.object({
    radius: z.number().min(2).max(32).default(8).describe('greet players this close'),
    perPlayerMinutes: z.number().min(1).max(1440).default(30).describe('do not greet the same player again for this long'),
    globalMinutes: z.number().min(0).max(1440).default(5).describe('pause after any greeting'),
    chance: z.number().min(0).max(1).default(0.5).describe('chance to greet per encounter'),
    lines: z.array(z.string().min(1).max(100)).optional().describe('greetings; {name} is the player')
  }),
  priority: 'idle',
  hook: (o) => greetPlayers({
    radius: o.radius,
    perPlayerMs: o.perPlayerMinutes * 60_000,
    globalMs: o.globalMinutes * 60_000,
    chance: o.chance,
    ...(o.lines?.length ? { lines: o.lines } : {})
  })
})

export const idleLook = defineBehavior({
  name: 'idle_look',
  category: 'idle',
  description: 'Fidgets when there is nothing else to do: glances at nearby players or looks around, so it looks alive.',
  options: z.object({
    everySeconds: z.number().min(2).max(120).default(8).describe('pause between glances'),
    radius: z.number().min(2).max(32).default(10).describe('look at players this close')
  }),
  requires: ['look_around'],
  priority: 'idle',
  create (o) {
    return {
      cooldownMs: o.everySeconds * 1000,
      score: ({ bot }) => bot.pathfinder?.isMoving?.() ? 0 : 5,
      run: (ctx) => ctx.act('look_around', { radius: o.radius })
    }
  }
})

