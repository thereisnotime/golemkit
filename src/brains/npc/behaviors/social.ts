import type { Behavior, NpcHook } from '../types.ts'

export interface FollowPlayerOptions {
  /** Notice players within this distance. Default 10. */
  radius?: number
  /** Keep this far from them. Default 3. */
  keepDistance?: number
  /** Hang around this long. Default 20000. */
  durationMs?: number
  /** Lose interest for this long afterwards. Default 90000. */
  cooldownMs?: number
  /** Default 18: a little above wander. */
  score?: number
}

/**
 * Social: walk over to a nearby player, look at them for a while, then lose interest.
 * Uses `goto_player` / `look_at` when present. Low score, so anything useful wins.
 */
export function followNearbyPlayer (opts: FollowPlayerOptions = {}): Behavior {
  const { radius = 10, keepDistance = 3, durationMs = 20000, cooldownMs = 90000, score = 18 } = opts
  return {
    name: 'follow_player',
    requires: ['goto_player'],
    cooldownMs,
    failureCooldownMs: 30000,
    score ({ bb }) {
      const p = bb.facts.nearestPlayer
      return p && p.distance <= radius ? score : 0
    },
    async run (ctx) {
      const who = ctx.bb.facts.nearestPlayer?.name
      if (!who) return 'nobody around'
      const until = Date.now() + durationMs
      while (Date.now() < until) {
        const entity = ctx.bot.players[who]?.entity
        if (!entity) return `${who} left`
        const d = entity.position.distanceTo(ctx.bot.entity.position)
        if (d > radius * 2) return `${who} went away`
        if (d > keepDistance + 2) await ctx.act('goto_player', { player: who })
        else if (ctx.agent.getAction('look_at')) await ctx.act('look_at', { player: who })
        await ctx.wait(1500)
      }
      return `hung out with ${who}`
    }
  }
}

export interface GreetOptions {
  /** Greet players within this distance. Default 8. */
  radius?: number
  /** Don't greet the same player again for this long. Default 30 min. */
  perPlayerMs?: number
  /** Don't greet anyone for this long after a greeting. Default 5 min. */
  globalMs?: number
  /** Chance to actually greet when allowed, per encounter. Default 0.5. */
  chance?: number
  lines?: string[]
}

/** Hook: says hello to players who come close, rarely (rate limited per player and globally). */
export function greetPlayers (opts: GreetOptions = {}): NpcHook {
  const {
    radius = 8, perPlayerMs = 30 * 60_000, globalMs = 5 * 60_000, chance = 0.5,
    lines = ['hello {name}', 'hi {name}', 'oh, hey {name}', 'good to see you, {name}']
  } = opts
  const seen = new Map<string, number>()
  let lastAny = -Infinity
  return (ctx) => {
    const p = ctx.bb.facts.nearestPlayer
    if (!p || p.distance > radius) return
    const last = seen.get(p.name) ?? -Infinity
    if (ctx.now - last < perPlayerMs) return
    // Each encounter gets one roll; a lost roll still counts as "seen".
    seen.set(p.name, ctx.now)
    if (ctx.now - lastAny < globalMs || Math.random() >= chance) return
    lastAny = ctx.now
    const line = lines[Math.floor(Math.random() * lines.length)]!
    ctx.agent.say(line.replace('{name}', p.name))
  }
}
