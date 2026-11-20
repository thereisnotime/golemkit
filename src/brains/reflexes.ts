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
}

export const reflexes = (opts: ReflexOptions = {}) => {
  const { selfDefense = true, autoEat = true, eatBelow = 15 } = opts
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

      const onHurt = (entity: any) => {
        if (!selfDefense || entity !== bot.entity) return
        if (agent.currentAction?.name === 'defend' || agent.currentAction?.name === 'attack') return
        if (nearestHostile(bot, bot.entity.position, 6)) void reflex('defend')
      }
      bot.on('entityHurt', onHurt)

      const timer = setInterval(() => {
        if (autoEat && bot.food < eatBelow && agent.getAction('eat') && bestFood(bot)) void reflex('eat')
      }, 2000)

      return () => {
        bot.off('entityHurt', onHurt)
        clearInterval(timer)
      }
    }
  })
}
