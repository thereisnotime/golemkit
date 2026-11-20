import type { Behavior } from '../types.ts'

export interface GoHomeOptions {
  /** Start heading home beyond this distance by day. Default 32. */
  maxDistance?: number
  /** At night, beyond this distance. Default 6. */
  nightDistance?: number
  /** Score when far by day; grows with distance up to +20. Default 35. */
  score?: number
  /** Score when away at night. Default 50. */
  nightScore?: number
}

/** Routine: get back home when strayed too far, and stay close at night. Needs `go_home`. */
export function goHome (opts: GoHomeOptions = {}): Behavior {
  const { maxDistance = 32, nightDistance = 6, score = 35, nightScore = 50 } = opts
  return {
    name: 'go_home',
    requires: ['go_home'],
    failureCooldownMs: 15000,
    score ({ bb, current }) {
      const d = bb.facts.homeDistance
      if (d === null || bb.facts.sleeping) return 0
      // Once on the way, finish the walk instead of stopping at the threshold.
      if (current === 'go_home' && d > 3) return bb.facts.isNight ? nightScore : score
      if (bb.facts.isNight && d > nightDistance) return nightScore
      if (d > maxDistance) return score + Math.min(20, (d - maxDistance) / 4)
      return 0
    },
    run: (ctx) => ctx.act('go_home', { range: 2 })
  }
}
