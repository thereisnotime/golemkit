// Reflexes: things the bot does on its own regardless of other brains: fight back when hit,
// eat when hungry. They run at reflex priority, so they briefly preempt everything else and
// long-running actions (follow, guard) resume afterwards.
import { defineBrain, PRIORITY, nearestHostile } from '../core/index.ts'
import { bestFood } from '../skills/survival.ts'

export interface ReflexOptions {
  selfDefense?: boolean
  autoEat?: boolean
  /** Eat when food drops below this. */
  eatBelow?: number
  /** At or below this health, back off instead of fighting. Default 8 (4 hearts). */
  retreatBelow?: number
  /** Don't fight mobs standing in water below this health (drowned, guardians). Default 14. */
  waterFightAbove?: number
}

export const reflexes = (opts: ReflexOptions = {}) => {
  const { selfDefense = true, autoEat = true, eatBelow = 15, retreatBelow = 8, waterFightAbove = 14 } = opts
  const caller = { kind: 'reflex', name: 'reflexes' } as const

  return defineBrain({
    name: 'reflexes',
    session (agent, bot) {
      let busy = false
      const reflex = async (action: string) => {
        if (busy) return
        busy = true
        try { await agent.act(action, {}, { caller, priority: PRIORITY.reflex }) } finally { busy = false }
      }

      const inWater = (e: any) => {
        const b = bot.blockAt(e.position)
        return b?.name === 'water' || e.name === 'drowned' || e.name === 'guardian'
      }
      const shouldRetreat = (mob: any) =>
        bot.health <= retreatBelow || (inWater(mob) && bot.health < waterFightAbove)

      const onHurt = (entity: any) => {
        if (!selfDefense || entity !== bot.entity) return
        const mob = nearestHostile(bot, bot.entity.position, 8)
        if (!mob) return
        const cur = agent.currentAction?.name
        if (shouldRetreat(mob) && agent.getAction('retreat')) {
          if (cur !== 'retreat') void reflex('retreat')
          return
        }
        if (cur === 'defend' || cur === 'attack' || cur === 'retreat') return
        void reflex('defend')
      }
      bot.on('entityHurt', onHurt)

      const timer = setInterval(() => {
        // Low health with a hostile close by: get away even before the next hit.
        const mob = selfDefense ? nearestHostile(bot, bot.entity.position, 6) : null
        if (mob && bot.health <= retreatBelow && agent.currentAction?.name !== 'retreat' && agent.getAction('retreat')) {
          void reflex('retreat')
          return
        }
        if (autoEat && bot.food < eatBelow && agent.getAction('eat') && bestFood(bot)) void reflex('eat')
        // Eat to heal when hurt and safe (food above 17 doesn't heal faster, but saturation helps).
        else if (autoEat && !mob && bot.health < 14 && bot.food < 20 && agent.getAction('eat') && bestFood(bot)) void reflex('eat')
      }, 2000)

      return () => {
        bot.off('entityHurt', onHurt)
        clearInterval(timer)
      }
    }
  })
}
