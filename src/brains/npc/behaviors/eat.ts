import type { Behavior } from '../types.ts'
import { bestFood } from '../../../skills/survival.ts'

export interface EatOptions {
  /**
   * Eat when food is below this. Default 12, deliberately under the reflexes' 15 so the
   * reflex eats first and this is the fallback for bots without it.
   */
  below?: number
}

/** Need: eat when hungry and there is food. Needs `eat`. */
export function eatWhenHungry (opts: EatOptions = {}): Behavior {
  const { below = 12 } = opts
  return {
    name: 'eat',
    requires: ['eat'],
    failureCooldownMs: 30000,
    score ({ bot, bb }) {
      if (bot.food >= below || !bestFood(bot)) return 0
      return 50 + bb.needs.hunger * 40
    },
    run: (ctx) => ctx.act('eat')
  }
}
