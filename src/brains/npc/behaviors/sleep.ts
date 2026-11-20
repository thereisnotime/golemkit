import type { Behavior } from '../types.ts'

export interface SleepOptions {
  /** Default 70. */
  score?: number
  /** Walk home first when farther than this (beds are looked up near the bot). Default 8. */
  homeRange?: number
}

/**
 * Routine: at night go home and sleep in a bed there, then lie in bed until morning.
 * Without a bed the `sleep` action fails and the failure back-off keeps it from retrying
 * every tick. Needs `sleep`; uses `go_home` if present.
 */
export function sleepAtNight (opts: SleepOptions = {}): Behavior {
  const { score = 70, homeRange = 8 } = opts
  return {
    name: 'sleep_at_night',
    requires: ['sleep'],
    failureCooldownMs: 60000,
    maxFailureCooldownMs: 600000,
    score: ({ bb }) => bb.facts.isNight || bb.facts.sleeping ? score : 0,
    async run (ctx) {
      const { bb, bot } = ctx
      if (!bot.isSleeping) {
        if (bb.facts.homeDistance !== null && bb.facts.homeDistance > homeRange && ctx.agent.getAction('go_home')) {
          const home = await ctx.act('go_home', { range: 2 })
          if (!home.ok) return home
        }
        const res = await ctx.act('sleep')
        if (!res.ok) return res
      }
      while (bot.isSleeping) await ctx.wait(2000)
      return 'slept'
    }
  }
}
