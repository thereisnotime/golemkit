import type { Behavior } from '../types.ts'

export interface WanderOptions {
  /** Radius around home by day. Default 12. */
  radius?: number
  /** Radius at night (stay close to home). Default 4. */
  nightRadius?: number
  /** Default 10: the fallback when nothing else matters. */
  score?: number
  /** Random pause after each walk, [min, max] ms. Default [3000, 12000]. */
  pauseMs?: [number, number]
}

/** Idle: short walks near home with pauses in between. Needs the `wander` action. */
export function wander (opts: WanderOptions = {}): Behavior {
  const { radius = 12, nightRadius = 4, score = 10, pauseMs = [3000, 12000] } = opts
  return {
    name: 'wander',
    requires: ['wander'],
    failureCooldownMs: 10000,
    score: () => score,
    async run (ctx) {
      const r = ctx.bb.facts.isNight ? nightRadius : radius
      const res = await ctx.act('wander', { radius: r })
      await ctx.wait(pauseMs[0] + Math.random() * (pauseMs[1] - pauseMs[0]))
      return res
    }
  }
}
