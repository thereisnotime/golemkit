import type { Behavior } from '../types.ts'

export interface DangerOptions {
  /** Fight mobs that come this close. Default 5. */
  fightRadius?: number
  /** Run instead of fighting below this health. Default 8. */
  fleeBelowHealth?: number
  /** Always run from these. Default creeper. */
  fleeFrom?: string[]
  /** 'auto' fights or flees by health, 'flee' never fights, 'fight' never flees. Default 'auto'. */
  mode?: 'auto' | 'fight' | 'flee'
}

/**
 * Danger: a hostile mob nearby (blackboard danger, within dangerRadius). Fights it with
 * `attack` when it's close and we're healthy, otherwise runs with `flee`. Scores 70-100.
 * Never targets players: attack only picks hostile mobs.
 */
export function fleeOrFight (opts: DangerOptions = {}): Behavior {
  const { fightRadius = 5, fleeBelowHealth = 8, fleeFrom = ['creeper'], mode = 'auto' } = opts
  const wantsFlee = (ctx: Parameters<Behavior['score']>[0]) => {
    const mob = ctx.bb.facts.nearestHostile
    if (!mob) return false
    if (mode === 'flee') return true
    if (mode === 'fight') return false
    return fleeFrom.includes(mob.name) || ctx.bot.health < fleeBelowHealth
  }
  return {
    name: 'danger',
    failureCooldownMs: 3000,
    maxFailureCooldownMs: 15000,
    score (ctx) {
      const mob = ctx.bb.facts.nearestHostile
      if (!mob) return 0
      const flee = wantsFlee(ctx)
      if (flee && !ctx.agent.getAction('flee')) return 0
      if (!flee && (mob.distance > fightRadius || !ctx.agent.getAction('attack'))) return 0
      return 70 + ctx.bb.needs.danger * 30
    },
    run (ctx) {
      if (wantsFlee(ctx)) return ctx.act('flee', { distance: 16 })
      const mob = ctx.bb.facts.nearestHostile
      return ctx.act('attack', mob ? { entityId: mob.id } : { radius: fightRadius + 2 })
    }
  }
}
